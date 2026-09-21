/**
 * magic-consult —— 统一按需检索入口（第一梯队 #1）。
 *
 * 行为蓝本：AgentCore tools/builtin/consult.py（name → 正文按名取文、软缺失列出
 * 可选名、输出 8000 上限、查阅缓存带 reused 标记）+ runtime/context/consultable.py
 * 的「目录 + 按名取文」共享源（目录与 fetch 不可漂移）+ systemPrompt「按需目录」。
 *
 * Magic 的目录源：记忆主题 + 按需规则（数据来自 magic-memory 服务）。
 * DSH 的技能目录本就常驻上下文，技能不进目录（与 AgentCore 的分工差异见 catalog.ts）。
 */

import { buildConsultCatalog, renderConsultDirectory, type ConsultCatalog, type MemoryConsultData } from './catalog.ts'

export const name = 'magic-consult'

export const inject = ['tools', 'systemPrompt', 'magicMemory', 'magicWorkMode']

const CONSULT_OUTPUT_LIMIT = 8000

interface SystemPromptService {
  section: (definition: {
    name: string
    order: number
    text: string | ((context?: { agent?: { session?: { id?: string } } }) => string)
  }) => unknown
}

interface ToolsService {
  register: (definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown, context?: unknown) => Promise<unknown> | unknown
  }) => unknown
}

/** magic-memory 服务（鸭子类型）。 */
interface MagicMemoryService {
  topics: (audience: 'ceo' | 'member') => ReadonlyArray<{ id: string; content: string; tags: readonly string[] }>
  rules: (audience: 'ceo' | 'member', onDemandOnly: boolean) => ReadonlyArray<{ id: string; content: string; tags: readonly string[] }>
}

interface MagicWorkModeService {
  getMode: (sessionId: string, session?: unknown) => 'agent' | 'ceo'
}

interface ConsultContext {
  tools: ToolsService
  systemPrompt: SystemPromptService
  magicMemory?: MagicMemoryService
  magicWorkMode?: MagicWorkModeService
}

function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

/** 会话受众：CEO 模式看全部；其余按 member（与 magic-memory 同一判定）。 */
function audienceOf(ctx: ConsultContext, sessionId: string | undefined): 'ceo' | 'member' {
  if (sessionId === undefined || ctx.magicWorkMode === undefined) return 'member'
  return ctx.magicWorkMode.getMode(sessionId) === 'ceo' ? 'ceo' : 'member'
}

/** 查阅缓存：同一会话进程内重复查阅同名条目直接复用（对齐 memory_consult_cache）。 */
const consultCache = new Map<string, { body: string; section: string }>

export function apply(ctx: ConsultContext): Promise<void> {
  if (ctx.magicMemory === undefined) {
    // magic-memory 缺席 = 目录为空：consult 仍注册（软缺失语义成立），不硬依赖。
    console.warn('[magic-consult] magicMemory service absent — consult directory starts empty')
  }
  const data: MemoryConsultData = ctx.magicMemory ?? { topics: () => [], rules: () => [] }

  const catalogFor = (sessionId: string | undefined): ConsultCatalog =>
    buildConsultCatalog(data, audienceOf(ctx, sessionId))

  // 系统提示词「按需目录」：与 consult.fetchByName 共用同一份目录（不可漂移）。
  ctx.systemPrompt.section({
    name: 'magic-consult-directory',
    order: 220,
    text: (context?: { agent?: { session?: { id?: string } } }) => {
      const sessionId = typeof context?.agent?.session?.id === 'string' ? context.agent.session.id : undefined
      return renderConsultDirectory(catalogFor(sessionId))
    },
  })

  ctx.tools.register({
    name: 'consult',
    description:
      '按 name 查阅一条按需条目：系统提示词「按需目录」列出全部 name 与一行说明'
      + '（记忆主题笔记、按需规则）。相关时拉全文再遵守。'
      + '缺 name 或名字不存在时会列出当前可查阅项。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '要查阅的条目名称，取自「按需目录」列出的 name。' },
      },
      required: ['name'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    execute(args: unknown, context?: unknown) {
      const session = context as { agent?: { session?: { id?: string } } } | undefined
      const sessionId = typeof session?.agent?.session?.id === 'string' ? session.agent.session.id : undefined
      const catalog = catalogFor(sessionId)
      const raw = typeof (args as { name?: unknown })?.name === 'string' ? String((args as { name?: unknown }).name).trim() : ''

      if (raw === '') {
        const available = catalog.entries.map((entry) => entry.name).join('、')
        return `缺少 name 参数。${available === '' ? '当前按需目录为空。' : `可查阅：${available}。`}`
      }

      const cached = consultCache.get(raw)
      if (cached !== undefined) {
        return `${cached.body}\n（复用缓存；section=${cached.section}）`
      }

      const body = catalog.fetchByName(raw)
      if (body === undefined) {
        const available = catalog.entries.map((entry) => entry.name).join('、')
        return `没有名为 '${raw}' 的条目。${available === '' ? '当前按需目录为空。' : ` 可查阅：${available}。`}`
      }

      const section = catalog.entries.find((entry) => entry.name === raw)?.section ?? 'memory'
      if (consultCache.size > 64) consultCache.clear()
      consultCache.set(raw, { body, section })
      return body.length > CONSULT_OUTPUT_LIMIT ? `${body.slice(0, CONSULT_OUTPUT_LIMIT)}\n…（截断）` : body
    },
  })

  return Promise.resolve()
}

// 测试钩子：清空查阅缓存。
export function resetConsultCacheForTests(): void {
  consultCache.clear()
}
