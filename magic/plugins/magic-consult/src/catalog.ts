/**
 * consult 目录构建（对齐 AgentCore runtime/context/consultable.py 的
 * ConsultDirectoryEntry + consult_sources.py 三源合并的语义，完全重写）。
 *
 * Magic 的目录源：
 * - 记忆主题（memory topics）：magic-memory 的 semantic 主题笔记
 *   （对齐 MemoryConsultSource 的 load_memory_topics）。
 * - 按需规则（on-demand rules）：rule 层且不带 `always` 标签的记录
 *   （带 always 的规则走常驻注入 rules_injection，不进目录——与 AgentCore 的
 *   「常驻在设定、按需进目录」分工一致）。
 * - 技能不进目录：DSH 的 skill-catalog 本来就常驻上下文，按需拉取是冗余。
 */

export interface ConsultDirectoryEntry {
  /** consult 的 name（目录里展示，fetch 用它取正文）。 */
  readonly name: string
  /** 一行说明。 */
  readonly summary: string
  /** 分组（memory / rule），只用于目录分组展示。 */
  readonly section: 'memory' | 'rule'
}

/** magic-memory 提供的服务面（鸭子类型，见 magic-memory/src/index.ts provide）。 */
export interface MemoryConsultData {
  topics: (audience: 'ceo' | 'member') => ReadonlyArray<{ id: string; content: string; tags: readonly string[] }>
  rules: (audience: 'ceo' | 'member', onDemandOnly: boolean) => ReadonlyArray<{ id: string; content: string; tags: readonly string[] }>
}

export interface ConsultCatalog {
  entries: readonly ConsultDirectoryEntry[]
  fetchByName: (name: string) => string | undefined
}

function firstLine(content: string, max = 80): string {
  const line = content.split('\n').find((item) => item.trim() !== '') ?? ''
  return line.trim().length > max ? `${line.trim().slice(0, max)}…` : line.trim()
}

function ruleName(record: { id: string; tags: readonly string[] }): string {
  return record.tags.find((tag) => tag.startsWith('rule:'))?.slice('rule:'.length) ?? `rule-${record.id.slice(0, 8)}`
}

/** 从 magic-memory 服务构建合并目录 + 按名取文（两者共用一份，不会漂移）。 */
export function buildConsultCatalog(data: MemoryConsultData, audience: 'ceo' | 'member'): ConsultCatalog {
  const entries: ConsultDirectoryEntry[] = []
  const bodies = new Map<string, string>()

  for (const note of data.topics(audience)) {
    const topic = note.tags.find((tag) => tag.startsWith('topic:'))?.slice('topic:'.length) ?? note.id
    if (bodies.has(topic)) continue
    entries.push({ name: topic, summary: firstLine(note.content), section: 'memory' })
    bodies.set(topic, note.content)
  }
  for (const rule of data.rules(audience, true)) {
    const name = ruleName(rule)
    if (bodies.has(name)) continue
    entries.push({ name, summary: firstLine(rule.content), section: 'rule' })
    bodies.set(name, rule.content)
  }

  return {
    entries,
    fetchByName: (name: string) => bodies.get(name.trim()),
  }
}

/** 渲染系统提示词的「按需目录」段；目录为空时返回空串。 */
export function renderConsultDirectory(catalog: ConsultCatalog): string {
  if (catalog.entries.length === 0) return ''
  const lines: string[] = ['<按需目录>', '相关时用 consult 工具按 name 拉取全文；常驻内容不在此列。']
  let currentSection = ''
  for (const entry of catalog.entries) {
    if (entry.section !== currentSection) {
      currentSection = entry.section
      lines.push(`[${entry.section === 'memory' ? '记忆主题' : '按需规则'}]`)
    }
    lines.push(`- ${entry.name}${entry.summary === '' ? '' : `：${entry.summary}`}`)
  }
  lines.push('</按需目录>')
  return lines.join('\n')
}
