import { RunPlan, RunPlanError, type RunSpec } from './plan.ts'

export const MAX_DELEGATION_TASKS = 20

export interface DelegateTask {
  id?: string
  role: string
  task: string
  dependsOn: string[]
  bindAfterDeps?: boolean
  /** 可选交付契约（原始形态，透传给 magic-ledger 归一化）。 */
  contract?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunPlanError(`ceo_delegate requires a non-empty ${field}`)
  }
  return value.trim()
}

function optionalIdList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new RunPlanError('depends_on must be an array of task ids or roles')
  }
  return value.map(item => item.trim())
}

/**
 * 可选交付契约。给了就必须是对象 —— 静默丢弃契约会让"物证验收"悄悄失效，
 * 而那正是接入账本要解决的问题，所以宁可报错。
 */
function optionalContract(value: unknown, field: string): { contract?: unknown } {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) {
    throw new RunPlanError(`${field} must be an object when provided`)
  }
  return { contract: value }
}

export function parseDelegateTasks(args: unknown): DelegateTask[] {
  if (!isRecord(args)) {
    throw new RunPlanError("ceo_delegate requires a 'tasks' array")
  }
  if (!Array.isArray(args.tasks)) {
    throw new RunPlanError("'tasks' array is required and cannot be empty")
  }
  if (args.tasks.length === 0) {
    throw new RunPlanError("'tasks' array is required and cannot be empty")
  }
  if (args.tasks.length > MAX_DELEGATION_TASKS) {
    throw new RunPlanError(`tasks exceeds ${String(MAX_DELEGATION_TASKS)}`)
  }

  return args.tasks.map((item, index) => {
    if (!isRecord(item)) {
      throw new RunPlanError(`tasks[${String(index)}] must be an object`)
    }
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    return {
      ...(id === '' ? {} : { id }),
      role: requiredString(item.role, `tasks[${String(index)}].role`),
      task: requiredString(item.task, `tasks[${String(index)}].task`),
      dependsOn: optionalIdList(item.depends_on),
      ...item.bind_after_deps === true ? { bindAfterDeps: true } : {},
      ...optionalContract(item.contract, `tasks[${String(index)}].contract`),
    }
  })
}

function resolveDep(
  token: string,
  byRawId: Map<string, string>,
  byRole: Map<string, string[]>,
): string {
  const fromId = byRawId.get(token)
  if (fromId !== undefined) return fromId
  const roleHits = byRole.get(token) ?? []
  if (roleHits.length === 1) return roleHits[0]!
  if (roleHits.length > 1) {
    throw new RunPlanError(`depends_on \`${token}\` is an ambiguous role`)
  }
  throw new RunPlanError(`depends_on \`${token}\` does not match a task id or role`)
}

function indexMaps(plan: RunPlan): {
  byRawId: Map<string, string>
  byRole: Map<string, string[]>
} {
  const byRawId = new Map<string, string>()
  const byRole = new Map<string, string[]>()
  for (const node of plan.nodes) {
    byRawId.set(node.rawId, node.runId)
    byRawId.set(node.runId, node.runId)
    const list = byRole.get(node.role) ?? []
    list.push(node.runId)
    byRole.set(node.role, list)
  }
  return { byRawId, byRole }
}

export function buildRunPlan(tasks: readonly DelegateTask[], prefix: string): RunPlan {
  const plan = new RunPlan()
  appendTasksToPlan(plan, tasks, prefix)
  return plan
}

/** Mint nodes onto an existing graph. depends_on may name live run_id, rawId, or a unique role. */
export function appendTasksToPlan(plan: RunPlan, tasks: readonly DelegateTask[], prefix: string): RunSpec[] {
  if (tasks.length === 0) return []

  const { byRawId, byRole } = indexMaps(plan)
  const rawIds = tasks.map((item, index) => item.id ?? `n${String(plan.nodes.length + index)}`)
  const seen = new Set<string>()
  for (const [index, rawId] of rawIds.entries()) {
    if (seen.has(rawId) || byRawId.has(rawId)) {
      throw new RunPlanError(`tasks[${String(index)}]: duplicate id '${rawId}'`)
    }
    seen.add(rawId)
  }

  // run_id 会成为账本物证的落盘 key（ev_<runId>_<ts>），而 DSH storage-json 的
  // per-record key 强制 path-safe [a-zA-Z0-9_-]+（storage-json/src/per-record-unit.ts
  // assertSafeKey）。模型给的节点 id 可能是任意文本（如中文座位名），铸造时 ASCII 化；
  // rawId 原样保留用于显示和 depends_on 解析。
  const minted = (raw: string, index: number): string => {
    const slug = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    return `${prefix}_${slug === '' ? `n${String(index)}` : slug}`
  }
  for (const [index, task] of tasks.entries()) {
    const rawId = rawIds[index]!
    const runId = minted(rawId, index)
    if (plan.byId(runId) !== undefined) {
      throw new RunPlanError(`duplicate run_id: ${runId}`)
    }
    byRawId.set(rawId, runId)
    byRawId.set(runId, runId)
    const list = byRole.get(task.role) ?? []
    list.push(runId)
    byRole.set(task.role, list)
  }

  const added: RunSpec[] = []
  for (const [index, task] of tasks.entries()) {
    const rawId = rawIds[index]!
    const spec: RunSpec = {
      runId: minted(rawId, index),
      rawId,
      role: task.role,
      task: task.task,
      dependsOn: task.dependsOn.map(token => resolveDep(token, byRawId, byRole)),
      ...task.bindAfterDeps === true ? { bindAfterDeps: true } : {},
      ...task.contract === undefined ? {} : { contract: task.contract },
    }
    plan.add(spec)
    added.push(spec)
  }
  plan.waves()
  return added
}
