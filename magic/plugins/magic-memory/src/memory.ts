/**
 * 记忆存储逻辑（纯逻辑，不调 DSH）。
 *
 * 围绕一张 `MagicTable<MemoryRecord>` 提供：写入 / 读取 / 更新 / 删除 / 按受众过滤 /
 * 检索。作用域隔离是这里的核心：一个 'member' 受众永远看不到 'ceo' 受众的记忆。
 */

import type { MagicTable } from './store.ts'
import { isVisibleOnChain } from './scope.ts'
import {
  makeMemoryRecord,
  type MemoryAudience,
  type MemoryLayer,
  type MemoryRecord,
  type NewMemoryInput,
} from './record.ts'

/** 更新一条记录时可改的字段。 */
export interface MemoryPatch {
  readonly content?: string
  readonly tags?: readonly string[]
  readonly source?: string
  readonly audience?: MemoryAudience
  readonly disputed?: boolean
}

/** 检索条件。audience 是「请求方受众」，用于作用域过滤。 */
export interface MemoryQuery {
  readonly audience: MemoryAudience
  readonly layer?: MemoryLayer
  readonly tags?: readonly string[]
  readonly query?: string
  readonly limit?: number
}

/** 未找到记录时抛出的错误。 */
export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`memory record '${id}' not found`)
    this.name = 'MemoryNotFoundError'
  }
}

/** 一条记录对某个请求方受众是否可见（作用域隔离的唯一真相）。 */
export function isVisibleTo(record: MemoryRecord, audience: MemoryAudience): boolean {
  // 'member' 受众只能看 member 可见的记忆；'ceo' 受众看全部（含 ceo 私有）。
  if (record.disputed) return false
  return isVisibleOnChain(record.audience, audience)
}

export class MemoryStore {
  private readonly table: MagicTable<MemoryRecord>

  constructor(table: MagicTable<MemoryRecord>) {
    this.table = table
  }

  /** 写入一条新记忆，返回带 id 与时间戳的完整记录。 */
  async add(input: NewMemoryInput): Promise<MemoryRecord> {
    const record = makeMemoryRecord(input)
    await this.table.put(record.id, record)
    return record
  }

  /** 同步读取（表读是同步的）。 */
  get(id: string): MemoryRecord | undefined {
    return this.table.get(id)
  }

  /** 按受众列出可见记忆（不含被否认的记忆），按更新时间倒序。 */
  list(audience: MemoryAudience): MemoryRecord[] {
    const out: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (isVisibleTo(record, audience)) out.push(record)
    }
    return out.sort(byUpdatedDesc)
  }

  /** 维护专用：枚举全部记录（含争议，不做受众过滤）——清扫争议滞留需要看到它们。 */
  listAll(): MemoryRecord[] {
    const out: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) out.push(record)
    return out.sort(byUpdatedDesc)
  }

  /** 按条件检索：先作用域过滤，再分层 / 标签 / 关键词，最后截断。 */
  search(query: MemoryQuery): MemoryRecord[] {
    const needle = typeof query.query === 'string' ? query.query.trim().toLowerCase() : ''
    const wantedTags = query.tags ?? []
    const out: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (!isVisibleTo(record, query.audience)) continue
      if (query.layer !== undefined && record.layer !== query.layer) continue
      if (wantedTags.length > 0 && !wantedTags.every((tag) => record.tags.includes(tag))) continue
      if (needle !== '' && !record.content.toLowerCase().includes(needle)
        && !record.tags.some((tag) => tag.toLowerCase().includes(needle))) {
        continue
      }
      out.push(record)
    }
    out.sort(byUpdatedDesc)
    const limit = typeof query.limit === 'number' && query.limit > 0 ? query.limit : out.length
    return out.slice(0, limit)
  }

  /** 更新一条记忆的可见字段，并刷新 updatedAt。 */
  async update(id: string, patch: MemoryPatch): Promise<MemoryRecord> {
    if (this.table.get(id) === undefined) throw new MemoryNotFoundError(id)
    const updated = await this.table.update(id, (current) => {
      const next: MemoryRecord = {
        ...current,
        ...patch.content !== undefined ? { content: patch.content } : {},
        ...patch.tags !== undefined ? { tags: patch.tags } : {},
        ...patch.source !== undefined ? { source: patch.source } : {},
        ...patch.audience !== undefined ? { audience: patch.audience } : {},
        ...patch.disputed !== undefined ? { disputed: patch.disputed } : {},
        updatedAt: new Date().toISOString(),
      }
      return next
    })
    return updated
  }

  /** 删除一条记忆，返回是否真的存在过。 */
  async remove(id: string): Promise<boolean> {
    return await this.table.delete(id)
  }
}

function byUpdatedDesc(a: MemoryRecord, b: MemoryRecord): number {
  if (a.updatedAt > b.updatedAt) return -1
  if (a.updatedAt < b.updatedAt) return 1
  return 0
}
