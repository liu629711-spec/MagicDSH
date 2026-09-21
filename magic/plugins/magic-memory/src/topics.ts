/**
 * 记忆深化：主题巩固 + 维护（对齐 AgentCore memory/consolidation.py 与
 * memory/maintenance.py 的产品语义，完全重写）。
 *
 * - 主题笔记（topic note）：semantic 层上按 `topic:<名>` 聚合出的单条正文，
 *   是 consult 目录的「记忆主题」来源（对齐 consult_sources.MemoryConsultSource
 *   的 load_memory_topics / topic_path）。
 * - 巩固（consolidate）：把同一主题下的零散 episodic/semantic 记录合并成一条
 *   主题笔记，源记录打 `consolidated` 标记保留原文（不删除，可追溯）。
 * - 维护（maintenance）：清理过期争议记录 + 分层/受众统计（对齐 dispute 通道
 *   与 retention 语义）。
 */

import type { MemoryAudience, MemoryRecord } from './record.ts'
import type { MemoryStore } from './memory.ts'

export const TOPIC_TAG = 'topic'
export function topicTagOf(topic: string): string {
  const name = topic.trim()
  if (name === '') throw new Error('topic 名不能为空')
  return `topic:${name}`
}

/** 某受众可见的主题笔记列表（consult 目录的「记忆主题」来源）。 */
export function listTopicNotes(store: MemoryStore, audience: MemoryAudience): MemoryRecord[] {
  return store
    .search({ audience, layer: 'semantic', tags: [TOPIC_TAG] })
    .map((record) => ({
      record,
      topic: record.tags.find((tag) => tag.startsWith('topic:'))?.slice('topic:'.length) ?? record.id,
    }))
    .sort((a, b) => a.topic.localeCompare(b.topic))
    .map((entry) => entry.record)
}

/** 巩固结果。 */
export interface ConsolidationResult {
  topic: string
  note: MemoryRecord
  /** 被合并的源记录 id。 */
  sourceIds: readonly string[]
  /** 是否更新了已存在的主题笔记（而非新建）。 */
  updated: boolean
}

/**
 * 把某主题下的零散记录（episodic/semantic，带 `topic:<名>` 标签、未被巩固过、
 * 未被否认）合并为一条主题笔记。幂等：重复调用更新同一条笔记。
 */
export async function consolidateTopic(
  store: MemoryStore,
  audience: MemoryAudience,
  topic: string,
): Promise<ConsolidationResult> {
  const tag = topicTagOf(topic)
  const all = store.search({ audience, tags: [tag] })
  const sources = all.filter((record) => record.layer === 'episodic' || record.layer === 'semantic')
  const sourcesNoNote = sources.filter((record) => !record.tags.includes(TOPIC_TAG))
  if (sourcesNoNote.length === 0) {
    throw new Error(`consolidate: 主题「${topic}」下没有可巩固的记录（需要 episodic/semantic 记录带标签 ${tag}）`)
  }

  const existing = store.search({ audience, layer: 'semantic', tags: [TOPIC_TAG, tag] })
    .find((record) => record.tags.includes('note'))
  const mergedBody = mergeBodies(topic, sourcesNoNote, existing)

  if (existing !== undefined) {
    const note = await store.update(existing.id, { content: mergedBody })
    for (const record of sourcesNoNote) {
      await store.update(record.id, { tags: [...new Set([...record.tags, 'consolidated'])] })
    }
    return { topic, note, sourceIds: sourcesNoNote.map((record) => record.id), updated: true }
  }

  const note = await store.add({
    layer: 'semantic',
    audience,
    content: mergedBody,
    tags: [TOPIC_TAG, tag, 'note'],
    source: 'consolidation',
  })
  for (const record of sourcesNoNote) {
    await store.update(record.id, { tags: [...new Set([...record.tags, 'consolidated'])] })
  }
  return { topic, note, sourceIds: sourcesNoNote.map((record) => record.id), updated: false }
}

function mergeBodies(
  topic: string,
  sources: readonly MemoryRecord[],
  existing: MemoryRecord | undefined,
): string {
  const lines: string[] = [`# 主题笔记：${topic}`, '']
  if (existing !== undefined) {
    lines.push(existing.content.split('\n').slice(2).join('\n').trim(), '')
  }
  for (const record of sources) {
    if (record.tags.includes('consolidated')) continue
    for (const line of record.content.split('\n')) {
      if (line.trim() === '') continue
      lines.push(`- ${line.trim()}（来源：${record.source === '' ? record.id : record.source}）`)
    }
  }
  return lines.join('\n').trim()
}

// ── 维护（对齐 AgentCore memory/maintenance.py 的 retention 语义） ─────────

export interface MaintenanceReport {
  purgedDisputed: number
  countsByLayer: Record<string, number>
  countsByAudience: Record<string, number>
  total: number
}

/**
 * 维护清扫：删除「争议且超过 maxAgeDays 天未更新」的记录（争议记忆本就不注入、
 * 不可检索，长期滞留只会膨胀域）；全域清扫（含 ceo 私有——争议滞留不分受众）；
 * 返回统计报告。
 */
export async function maintain(
  store: MemoryStore,
  _audience: MemoryAudience,
  maxAgeDays = 30,
): Promise<MaintenanceReport> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let purgedDisputed = 0
  const countsByLayer: Record<string, number> = {}
  const countsByAudience: Record<string, number> = {}
  let total = 0

  for (const record of store.listAll()) {
    total += 1
    countsByLayer[record.layer] = (countsByLayer[record.layer] ?? 0) + 1
    countsByAudience[record.audience] = (countsByAudience[record.audience] ?? 0) + 1
    if (record.disputed && Date.parse(record.updatedAt) < cutoff) {
      if (await store.remove(record.id)) purgedDisputed += 1
      total -= 1
      countsByLayer[record.layer] = (countsByLayer[record.layer] ?? 0) - 1
      countsByAudience[record.audience] = (countsByAudience[record.audience] ?? 0) - 1
    }
  }
  return { purgedDisputed, countsByLayer, countsByAudience, total }
}
