/**
 * `magic_ceo` 域：CEO 运行时状态的持久化门面（W1）。
 *
 * 背景：现在 CEO 的全部状态存在 6 个进程序 Map 里
 * （plugins/magic-ceo/src/index.ts:123-135），进程一崩就靠回放事件猜。
 * 本模块把这些状态搬进 `ctx.storageDomain` 的 `magic_ceo` 域。
 *
 * ## 设计边界（重要）
 *
 * 只持久化**可序列化的持久状态**：
 *   - members  成员座席（runId / role / task / dependsOn / phase / steer / bindAfterDeps / turnSeq）
 *   - plans    计划（turn / planId / version / summary / analysis / teamBrief / tasks）
 *   - usage    用量（inputTokens / outputTokens / …）
 *   - channels 上下文通道（channel / chars / truncated）
 *
 * **不持久化运行时句柄**：`AbortController`、`LiveGraph.plan`（RunPlan 类）、
 * `specs`/`states` 的活对象 —— 这些是进程内句柄，重启后必须重建，不落盘。
 * 重启后未完成的 run 由既有机制标 `unknown_after_restart`
 * （见 index.ts 的 `unknownAfterRestartRuns` / `freezeInFlightAfterRestart`）。
 *
 * ## 记录形状
 *
 * 本节定义的 `Persisted*` 类型是**持久化 schema 的规范形状**，结构上镜像
 * index.ts / journal.ts 的运行时类型，但刻意不 import 它们（避免循环依赖）。
 * 接线时由 index.ts 负责映射。
 */
import { magicDomain, passthrough } from './schema.ts'
import type { MagicDomain, MagicDomainSpec, MagicTable, StorageDomainPort } from './types.ts'

export const CEO_DOMAIN_NAME = 'magic_ceo'
export const CEO_DOMAIN_VERSION = 1

/** 组合键分隔符：用 U+0001，正常 ID 里不会出现。 */
const KEY_SEP = '\u0001'

// ── 持久化记录形状 ────────────────────────────────────────────────────────

/** 镜像 plugins/magic-ceo/src/index.ts:41-54 的 `CeoMember`。 */
export interface PersistedMember {
  runId: string
  rawId: string
  memberId?: string
  /** 官方名册名（半改道后经 agentTeams 派出的成员才有；steer/halt 按名路由）。 */
  officialName?: string
  parentSessionId: string
  role: string
  task: string
  dependsOn: string[]
  /** 镜像 `RunState['phase']`；此层不 import 该类型，故放宽为 string。 */
  phase: string
  createdAt: string
  steer?: string
  bindAfterDeps?: boolean
  turnSeq?: number
}

/** 镜像 plugins/magic-ceo/src/journal.ts 的 `CeoPlanTask`。 */
export interface PersistedPlanTask {
  id?: string
  role: string
  task: string
  dependsOn: string[]
  bindAfterDeps?: boolean
}

/** 镜像 plugins/magic-ceo/src/journal.ts:23-31 的 `CeoPlanData`。 */
export interface PersistedPlan {
  turn: number
  planId: string
  version: number
  summary: string
  analysis: string
  teamBrief?: string
  tasks: PersistedPlanTask[]
}

/** 镜像 plugins/magic-ceo/src/journal.ts:406-414 的 `CeoTokenUsage`。 */
export interface PersistedUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 镜像 plugins/magic-ceo/src/journal.ts:423-427 的 `CeoContextChannel`。 */
export interface PersistedChannel {
  channel: string
  chars: number
  truncated: boolean
}

// ── 域声明 ────────────────────────────────────────────────────────────────

/** 组合键：parentSessionId + 子标识（runId 或 memberId）。 */
export function recordKey(parentSessionId: string, childId: string): string {
  return `${parentSessionId}${KEY_SEP}${childId}`
}

/**
 * `magic_ceo` 域声明。
 *
 * layout 取 `'single'`：一个 CEO 图的持久状态是有界的（几个到几十个座席），
 * 整域一个文档的写放大可接受（内核 §4）。
 */
export function ceoDomainSpec(): MagicDomainSpec {
  return magicDomain({
    name: CEO_DOMAIN_NAME,
    version: CEO_DOMAIN_VERSION,
    layout: 'single',
    tables: {
      members: { valueSchema: passthrough<PersistedMember>() },
      plans: { valueSchema: passthrough<PersistedPlan>() },
      usage: { valueSchema: passthrough<PersistedUsage>() },
      channels: { valueSchema: passthrough<PersistedChannel[]>() },
    },
  })
}

// ── 门面 ──────────────────────────────────────────────────────────────────

export interface CeoStore {
  /** 底层域句柄（诊断用）。 */
  readonly domain: MagicDomain
  /** 关闭域并释放后端单元。 */
  close(): Promise<void>

  // 成员座席
  putMember(member: PersistedMember): Promise<void>
  getMember(parentSessionId: string, runId: string): PersistedMember | undefined
  membersOf(parentSessionId: string): PersistedMember[]
  removeMember(parentSessionId: string, runId: string): Promise<boolean>

  // 计划
  putPlan(parentSessionId: string, plan: PersistedPlan): Promise<void>
  getPlan(parentSessionId: string): PersistedPlan | undefined

  // 用量（累加，串行安全）
  addUsage(parentSessionId: string, memberId: string, delta: PersistedUsage): Promise<PersistedUsage>
  usageOf(parentSessionId: string): Map<string, PersistedUsage>

  // 上下文通道
  putChannels(parentSessionId: string, memberId: string, channels: readonly PersistedChannel[]): Promise<void>
  channelsOf(parentSessionId: string, memberId: string): PersistedChannel[]

  /** 本域已知的全部 parentSessionId（按成员/计划表单据推导）。 */
  parentSessions(): string[]
}

const EMPTY_USAGE: PersistedUsage = { inputTokens: 0, outputTokens: 0 }

/**
 * 打开 `magic_ceo` 域并返回门面。
 * @param port - 存储端口：生产传 `createDshPort(ctx)`，测试传 `createMemoryPort()`。
 */
export async function openCeoStore(port: StorageDomainPort): Promise<CeoStore> {
  const domain = await port.open(ceoDomainSpec())
  const members = domain.table<PersistedMember>('members')
  const plans = domain.table<PersistedPlan>('plans')
  const usage = domain.table<PersistedUsage>('usage')
  const channels = domain.table<PersistedChannel[]>('channels')

  function keysWithPrefix(table: MagicTable<unknown>, parentSessionId: string): string[] {
    const prefix = `${parentSessionId}${KEY_SEP}`
    const out: string[] = []
    for (const key of table.keys()) {
      if (key.startsWith(prefix)) out.push(key.slice(prefix.length))
    }
    return out
  }

  return {
    domain,

    close(): Promise<void> {
      return domain.close()
    },

    async putMember(member: PersistedMember): Promise<void> {
      // 存副本：DSH 约定返回值就是存储对象本身，不得就地改写。
      await members.put(recordKey(member.parentSessionId, member.runId), {
        ...member,
        dependsOn: [...member.dependsOn],
      })
    },

    getMember(parentSessionId: string, runId: string): PersistedMember | undefined {
      return members.get(recordKey(parentSessionId, runId))
    },

    membersOf(parentSessionId: string): PersistedMember[] {
      const out: PersistedMember[] = []
      for (const runId of keysWithPrefix(members as MagicTable<unknown>, parentSessionId)) {
        const record = members.get(recordKey(parentSessionId, runId))
        if (record !== undefined) out.push(record)
      }
      return out
    },

    removeMember(parentSessionId: string, runId: string): Promise<boolean> {
      return members.delete(recordKey(parentSessionId, runId))
    },

    async putPlan(parentSessionId: string, plan: PersistedPlan): Promise<void> {
      await plans.put(parentSessionId, {
        ...plan,
        tasks: plan.tasks.map(task => ({ ...task, dependsOn: [...task.dependsOn] })),
      })
    },

    getPlan(parentSessionId: string): PersistedPlan | undefined {
      return plans.get(parentSessionId)
    },

    async addUsage(parentSessionId: string, memberId: string, delta: PersistedUsage): Promise<PersistedUsage> {
      const key = recordKey(parentSessionId, memberId)
      // 先播种再累加：并发首写不会丢增量（update 在域写链上串行）。
      if (usage.get(key) === undefined) await usage.put(key, { ...EMPTY_USAGE })
      return await usage.update(key, current => mergeUsage(current, delta))
    },

    usageOf(parentSessionId: string): Map<string, PersistedUsage> {
      const out = new Map<string, PersistedUsage>()
      for (const memberId of keysWithPrefix(usage as MagicTable<unknown>, parentSessionId)) {
        const record = usage.get(recordKey(parentSessionId, memberId))
        if (record !== undefined) out.set(memberId, record)
      }
      return out
    },

    async putChannels(parentSessionId: string, memberId: string, list: readonly PersistedChannel[]): Promise<void> {
      await channels.put(recordKey(parentSessionId, memberId), list.map(item => ({ ...item })))
    },

    channelsOf(parentSessionId: string, memberId: string): PersistedChannel[] {
      return channels.get(recordKey(parentSessionId, memberId)) ?? []
    },

    parentSessions(): string[] {
      const seen = new Set<string>()
      for (const table of [members, plans, usage, channels] as MagicTable<unknown>[]) {
        for (const key of table.keys()) {
          const sep = key.indexOf(KEY_SEP)
          seen.add(sep === -1 ? key : key.slice(0, sep))
        }
      }
      return [...seen]
    },
  }
}

/** 数值字段求和；可选字段只在 delta 提供时覆盖。 */
function mergeUsage(current: PersistedUsage, delta: PersistedUsage): PersistedUsage {
  const next: PersistedUsage = {
    inputTokens: current.inputTokens + delta.inputTokens,
    outputTokens: current.outputTokens + delta.outputTokens,
  }
  const sumIfPresent = (key: 'totalTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'): void => {
    const left = current[key]
    const right = delta[key]
    if (left === undefined && right === undefined) return
    next[key] = (left ?? 0) + (right ?? 0)
  }
  sumIfPresent('totalTokens')
  sumIfPresent('cacheReadTokens')
  sumIfPresent('cacheWriteTokens')
  sumIfPresent('reasoningTokens')
  return next
}
