/**
 * magic-memory 插件入口（契约内核 §1.2 / §2 / §3.4）。
 *
 * 铁律：不 import 任何 `@deepseek-ai/dsh-*` 包；全部宿主能力用结构化类型鸭子匹配。
 * 域端口从 ctx.storageDomain 取得（测试时由调用方注入一个内存端口伪装 storageDomain）。
 */

import {
  buildMemorySpec,
  createDshPort,
  magicDomain,
  type MagicDomainSpec,
  type StorageDomainPort,
} from './store.ts'
import { MemoryStore } from './memory.ts'
import { renderMemorySection, toSearchResult } from './inject.ts'
import { consolidateTopic, listTopicNotes, maintain } from './topics.ts'
import type { MemoryAudience, MemoryLayer, MemoryRecord } from './record.ts'

export const name = 'magic-memory'

/** 依赖的 Cordis 服务：systemPrompt（注入）、tools（检索工具）、storageDomain（持久）、magicWorkMode（判定 CEO/成员）。 */
export const inject = ['systemPrompt', 'tools', 'storageDomain', 'magicWorkMode']

interface MagicWorkModeService {
  getMode: (sessionId: string, session?: unknown) => 'agent' | 'ceo'
}

interface PromptAssembleContext {
  agent?: { session?: { id?: string } }
}

interface SystemPromptService {
  section: (definition: {
    name: string
    order: number
    text: string | ((context?: PromptAssembleContext) => string)
  }) => unknown
}

interface ToolsService {
  register: (definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    /**
     * DSH 强制要求：工具必须声明 output，否则加载期直接 fatal
     * （`tool "X" must declare output { schema, render, presentationMeta? }`）。
     * 单元测试用假的 register，不会触发该校验，只有真实加载才暴露。
     */
    output: {
      schema: Record<string, unknown>
      render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
    }
    execute: (args: unknown, context?: unknown) => Promise<unknown> | unknown
  }) => unknown
}

/** 工具输出的文本渲染：字符串直出，其余 JSON 化。 */
function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

interface MagicContext {
  systemPrompt: SystemPromptService
  tools: ToolsService
  storageDomain?: { open: (spec: MagicDomainSpec) => Promise<unknown> }
  magicWorkMode?: MagicWorkModeService
  // Cordis effect(setup)：setup 立即执行，其返回值（可为 disposer 函数）由宿主在卸载时调用。
  effect?: (setup: () => void | Promise<void> | (() => void)) => unknown
  on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown
  emit?: (event: string, payload: unknown) => void
  provide?: (name: string, value: unknown) => unknown
}

/** 当前会话的受众：CEO 模式看到全部，其余只看到 member 可见记忆。 */
function audienceOf(ctx: MagicContext, sessionId: string | undefined): MemoryAudience {
  if (sessionId === undefined || ctx.magicWorkMode === undefined) return 'member'
  return ctx.magicWorkMode.getMode(sessionId) === 'ceo' ? 'ceo' : 'member'
}

export function apply(ctx: MagicContext): Promise<void> {
  const port: StorageDomainPort = createDshPort(ctx)
  const spec = magicDomain(buildMemorySpec())

  return port.open(spec).then((domain) => {
    console.log('[magic-memory] plugin loaded')
    const table = domain.table<MemoryRecord>('memories')
    const store = new MemoryStore(table)

    // 常驻注入：按角色过滤可见记忆。
    ctx.systemPrompt.section({
      name: 'magic-memory',
      order: 200,
      text: (context?: PromptAssembleContext) => {
        const sessionId = typeof context?.agent?.session?.id === 'string'
          ? context.agent.session.id
          : undefined
        const audience = audienceOf(ctx, sessionId)
        return renderMemorySection(store.list(audience), { audience }).text
      },
    })

    // 常驻规则注入（对齐 AgentCore rules_injection）：rule 层且带 `always` 标签的
    // 记录无条件进入系统提示词——这是「硬规则」；不带 always 的规则走 consult 按需目录。
    ctx.systemPrompt.section({
      name: 'magic-memory-rules',
      order: 210,
      text: (context?: PromptAssembleContext) => {
        const sessionId = typeof context?.agent?.session?.id === 'string'
          ? context.agent.session.id
          : undefined
        const audience = audienceOf(ctx, sessionId)
        const rules = store.search({ audience, layer: 'rule', tags: ['always'] })
        if (rules.length === 0) return ''
        return ['<必须遵守的规则>', ...rules.map((rule) => `- ${rule.content}`), '</必须遵守的规则>'].join('\n')
      },
    })

    // 检索工具：供 CEO / 成员按需拉取记忆。
    ctx.tools.register({
      name: 'magic_memory_search',
      description:
        'Search Magic long-term memory. Filter by audience (scope), layer, tags, or free text. '
        + 'A member audience never sees CEO-private memories.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          audience: {
            type: 'string',
            enum: ['ceo', 'member'],
            description: 'Who is asking. "member" cannot see CEO-private memories.',
          },
          layer: {
            type: 'string',
            enum: ['episodic', 'semantic', 'user', 'rule'],
            description: 'Optional memory layer filter.',
          },
          query: { type: 'string', description: 'Optional free-text match against content and tags.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional AND-of-tags filter.' },
          limit: { type: 'number', description: 'Max records to return.' },
        },
        required: ['audience'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            audience: { type: 'string' },
            count: { type: 'number' },
            records: { type: 'array', items: { type: 'object' } },
          },
          required: ['audience', 'count', 'records'],
        },
        render: textRender,
      },
      async execute(args: unknown) {
        const raw = (args ?? {}) as Record<string, unknown>
        const audience = raw.audience === 'ceo' ? 'ceo' : 'member'
        const layer = raw.layer as MemoryLayer | undefined
        const query = typeof raw.query === 'string' ? raw.query : undefined
        const tags = Array.isArray(raw.tags)
          ? raw.tags.filter((t): t is string => typeof t === 'string')
          : undefined
        const limit = typeof raw.limit === 'number' ? raw.limit : undefined
        const found = store.search({ audience, ...layer ? { layer } : {}, ...query ? { query } : {}, ...tags ? { tags } : {}, ...limit ? { limit } : {} })
        return toSearchResult(found, audience)
      },
    })

    // 写入工具：把本次经验/事实/偏好/规则记入长期记忆。
    ctx.tools.register({
      name: 'magic_memory_record',
      description:
        'Record one memory item (episodic event, semantic fact, user preference, or rule). '
        + 'Set audience to "ceo" to keep it CEO-private; "member" makes it visible to everyone.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: { type: 'string', enum: ['episodic', 'semantic', 'user', 'rule'] },
          audience: { type: 'string', enum: ['ceo', 'member'] },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          source: { type: 'string', description: 'Where this memory came from.' },
        },
        required: ['layer', 'audience', 'content'],
      },
      output: {
        schema: { type: 'object', properties: {} },
        render: textRender,
      },
      async execute(args: unknown) {
        const raw = (args ?? {}) as Record<string, unknown>
        const layer = raw.layer as MemoryLayer
        const audience = raw.audience === 'ceo' ? 'ceo' : 'member'
        const content = typeof raw.content === 'string' ? raw.content : ''
        const tags = Array.isArray(raw.tags)
          ? raw.tags.filter((t): t is string => typeof t === 'string')
          : undefined
        const source = typeof raw.source === 'string' ? raw.source : undefined
        const record = await store.add({ layer, audience, content, ...tags ? { tags } : {}, ...source ? { source } : {} })
        ctx.emit?.('magic:memory:recorded', record)
        return record
      },
    })

    // 巩固工具：把同一主题下的零散记录合并为主题笔记（consult 目录的记忆主题来源）。
    ctx.tools.register({
      name: 'memory_consolidate',
      description:
        'Consolidate scattered episodic/semantic records tagged `topic:<name>` into one semantic '
        + 'topic note (idempotent; sources are kept and tagged `consolidated`). Topic notes are '
        + 'what the consult directory lists as memory topics.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          audience: { type: 'string', enum: ['ceo', 'member'] },
          topic: { type: 'string', description: 'Topic name (without the `topic:` prefix).' },
        },
        required: ['audience', 'topic'],
      },
      output: { schema: { type: 'object', properties: {} }, render: textRender },
      async execute(args: unknown) {
        const raw = (args ?? {}) as Record<string, unknown>
        const audience = raw.audience === 'ceo' ? 'ceo' : 'member'
        const topic = typeof raw.topic === 'string' ? raw.topic.trim() : ''
        const result = await consolidateTopic(store, audience, topic)
        ctx.emit?.('magic:memory:consolidated', { topic, noteId: result.note.id, sources: result.sourceIds.length })
        return { topic: result.topic, noteId: result.note.id, merged: result.sourceIds.length, updated: result.updated }
      },
    })

    // 维护工具：清理过期争议记录 + 分层/受众统计。
    ctx.tools.register({
      name: 'memory_maintain',
      description:
        'Memory housekeeping: purge disputed records older than maxAgeDays (default 30) and '
        + 'return counts by layer and audience.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          audience: { type: 'string', enum: ['ceo', 'member'] },
          maxAgeDays: { type: 'number', description: 'Default 30.' },
        },
        required: ['audience'],
      },
      output: { schema: { type: 'object', properties: {} }, render: textRender },
      async execute(args: unknown) {
        const raw = (args ?? {}) as Record<string, unknown>
        const audience = raw.audience === 'ceo' ? 'ceo' : 'member'
        const maxAgeDays = typeof raw.maxAgeDays === 'number' && raw.maxAgeDays > 0 ? raw.maxAgeDays : 30
        return await maintain(store, audience, maxAgeDays)
      },
    })

    // 服务面：magic-consult（目录 + 按名取文的数据源）从这里读。
    ctx.provide?.('magicMemory', {
      store,
      audienceOf: () => audienceOf(ctx, undefined),
      topics: (audience: MemoryAudience) => listTopicNotes(store, audience),
      rules: (audience: MemoryAudience, onDemandOnly: boolean) => {
        const rules = store.search({ audience, layer: 'rule' })
        return onDemandOnly ? rules.filter((rule) => !rule.tags.includes('always')) : rules
      },
    })

    // 生命周期：插件卸载时关闭域（内核 §3.4）。
    // Cordis 的 effect 语义是 `effect(setup)`：setup 立即执行，其返回值才是 disposer。
    // 写成 `ctx.effect(() => { void domain.close() })` 会当场关闭域。
    ctx.effect?.(() => () => { void domain.close() })
  })
}
