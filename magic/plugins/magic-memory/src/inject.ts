/**
 * 记忆注入片段生成（纯函数，不直接调 DSH，便于测试）。
 *
 * 给定一组记忆记录，按分层分组渲染为 system-prompt 片段。会按受众二次过滤，
 * 并对过长正文与总字数做截断（避免撑爆上下文）。
 */

import type { MemoryAudience, MemoryLayer, MemoryRecord } from './record.ts'
import { isVisibleTo } from './memory.ts'

export interface InjectionOptions {
  /** 请求方受众：决定可见性（'member' 看不到 'ceo' 私有记忆）。 */
  readonly audience: MemoryAudience
  /** 单条正文最大字符数（默认 2000）。 */
  readonly maxCharsPerRecord?: number
  /** 注入片段总字数上限（默认 6000）。 */
  readonly maxTotalChars?: number
  /** 最多注入多少条（默认 50）。 */
  readonly maxRecords?: number
}

const LAYER_ORDER: readonly MemoryLayer[] = ['rule', 'user', 'semantic', 'episodic']
const LAYER_LABEL: Record<MemoryLayer, string> = {
  rule: '规则',
  user: '用户偏好',
  semantic: '事实',
  episodic: '事件',
}

const DEFAULT_MAX_CHARS_PER_RECORD = 2000
const DEFAULT_MAX_TOTAL_CHARS = 6000
const DEFAULT_MAX_RECORDS = 50

export interface RenderedSection {
  readonly text: string
  readonly count: number
  /** 实际渲染的字符数（截断前若超 maxTotalChars 会被裁掉尾部）。 */
  readonly chars: number
  readonly truncated: boolean
}

/**
 * 把一组记忆渲染为注入片段。调用方应传入「已经按受众过滤」的记录；
 * 这里会再做一次防御性过滤（isVisibleTo），并做超长截断。
 */
export function renderMemorySection(
  records: readonly MemoryRecord[],
  options: InjectionOptions,
): RenderedSection {
  const maxChars = options.maxCharsPerRecord ?? DEFAULT_MAX_CHARS_PER_RECORD
  const maxTotal = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS

  const visible = records
    .filter((record) => isVisibleTo(record, options.audience))
    .sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer))

  // 真没有任何可见记忆：返回占位，不标记为截断。
  if (visible.length === 0) {
    return { text: '(暂无可见记忆)', count: 0, chars: 0, truncated: false }
  }

  const byLayer = new Map<MemoryLayer, MemoryRecord[]>()
  for (const layer of LAYER_ORDER) byLayer.set(layer, [])
  for (const record of visible) byLayer.get(record.layer)?.push(record)

  const lines: string[] = []
  let totalChars = 0
  let count = 0
  let truncated = false

  for (const layer of LAYER_ORDER) {
    const group = byLayer.get(layer) ?? []
    if (group.length === 0) continue
    lines.push(`【${LAYER_LABEL[layer]}】`)
    for (const record of group) {
      if (count >= maxRecords) { truncated = true; break }
      const body = truncate(record.content, maxChars)
      const tagPart = record.tags.length > 0 ? ` #${record.tags.join(' #')}` : ''
      const line = `- ${body}${tagPart}`
      if (totalChars + line.length + 1 > maxTotal) { truncated = true; break }
      lines.push(line)
      totalChars += line.length + 1
      count += 1
    }
    if (truncated) break
  }

  if (count === 0) {
    // 有可见记忆但全部被总字数上限截断：保留层标题并标记截断。
    return { text: lines.join('\n'), count: 0, chars: totalChars, truncated }
  }
  return { text: lines.join('\n'), count, chars: totalChars, truncated }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（已截断）`
}

/**
 * 供检索工具返回的纯数据结构（不与 DSH 耦合）。
 */
export interface MemorySearchResult {
  readonly audience: MemoryAudience
  readonly count: number
  readonly records: ReadonlyArray<MemoryRecord>
}

export function toSearchResult(
  records: ReadonlyArray<MemoryRecord>,
  audience: MemoryAudience,
): MemorySearchResult {
  return { audience, count: records.length, records }
}
