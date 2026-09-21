/**
 * 工作区符号索引管理器 —— IndexManager/IndexMaintainer 等价物
 * （蓝本 AgentCore workspace/indexing/manager.py + maintainer.py）。
 *
 * 蓝本语义（manager.py）：
 * - 增量构建：按 (mtime_ms, size_bytes) 指纹跳过未变文件（:178-184）；
 *   内容 hash 变了才重新 chunk（:218-224）；消失的文件从索引移除（:174-177）；
 * - 文件清单封顶 5000（:28 _MAX_INDEX_FILES），封顶即 truncated → STALE（:149）；
 * - 状态两轴：快照是否可用 vs 内容是否 dirty（:136-151 index_status）；
 * - 查询只读当前快照，search 绝不触发构建（manager.py:43、267-305）。
 *
 * Magic 简化（报告中说明）：索引缓存放内存（模块级 Map，key=工作区根），
 * 不落 SQLite；首次查询由工具层同步 await ensureAsync（等价蓝本
 * 「查询 + IndexMaintainer 后台 kick」并保证首查可用）；maintainer.py 的
 * 异步合并调度在同步工具路径里天然不需要。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bm25Rank, normalizeScores, type BM25Document } from './bm25.ts'
import { chunkFile, chunkToDocTokens, detectLanguage, type RawChunk } from './chunker.ts'
import { queryTerms } from './tokenize.ts'

export const MAX_INDEX_FILES = 5000

/** 必剪枝目录（对齐一期 archive 剪枝面 + manager.py 的 is_ignored_relpath 意图）。 */
export const IGNORED_DIRS = new Set(['.git', 'node_modules'])

/** 单文件索引上限（字节）：超大产物文件不进索引。 */
export const MAX_FILE_BYTES = 1_000_000

export type CodeIndexStatus = 'READY' | 'BUILDING' | 'STALE'

export interface CodeChunkHit {
  chunk: RawChunk
  score: number
}

interface FileEntry {
  mtimeMs: number
  sizeBytes: number
  hash: string
  chunks: RawChunk[]
}

export class WorkspaceCodeIndex {
  readonly root: string
  private readonly files = new Map<string, FileEntry>()
  private hasSnapshot = false
  private truncated = false
  private building = false

  constructor(root: string) {
    this.root = root
  }

  get status(): CodeIndexStatus {
    if (this.building && !this.hasSnapshot) return 'BUILDING'
    if (!this.hasSnapshot || this.truncated) return 'STALE'
    return 'READY'
  }

  get indexedFileCount(): number {
    return this.files.size
  }

  /**
   * 增量 ensure（manager.py:163-242 ensure_index）：扫工作区可索引文件，
   * 指纹不变跳过，内容变了重建 chunk，消失的移除。返回是否有重建。
   */
  async ensureAsync(): Promise<boolean> {
    if (this.building) return false
    this.building = true
    let updated = false
    try {
      const listed = this.listFiles()
      const current = new Set(listed.paths)

      // 消失的文件移除（manager.py:174-177）。
      for (const path of [...this.files.keys()]) {
        if (!current.has(path)) {
          this.files.delete(path)
          updated = true
        }
      }

      for (const relPath of listed.paths) {
        const abs = join(this.root, relPath)
        let stat
        try {
          stat = statSync(abs)
        } catch {
          continue
        }
        const mtimeMs = Math.floor(stat.mtimeMs)
        const sizeBytes = stat.size
        const existing = this.files.get(relPath)
        // 指纹不变 → 跳过（manager.py:178-184）。
        if (existing !== undefined && existing.mtimeMs === mtimeMs && existing.sizeBytes === sizeBytes) {
          continue
        }
        let content: string
        try {
          content = readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        const hash = createHash('sha256').update(content, 'utf8').digest('hex')
        if (existing !== undefined && existing.hash === hash) {
          // 内容没变（mtime 抖动）：只刷新指纹（manager.py:222-224）。
          existing.mtimeMs = mtimeMs
          existing.sizeBytes = sizeBytes
          continue
        }
        const language = detectLanguage(relPath)
        const chunks = await chunkFile(relPath, content, language)
        this.files.set(relPath, { mtimeMs, sizeBytes, hash, chunks })
        updated = true
      }

      // commit_meta（manager.py:235-238）。
      this.hasSnapshot = true
      this.truncated = listed.truncated
      return updated
    } finally {
      this.building = false
    }
  }

  private listFiles(): { paths: string[]; truncated: boolean } {
    const paths: string[] = []
    let truncated = false
    const walk = (relDir: string): void => {
      if (truncated) return
      const absDir = relDir === '' ? this.root : join(this.root, relDir)
      let entries
      try {
        entries = readdirSync(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (truncated) return
        const name = entry.name
        const rel = relDir === '' ? name : `${relDir}/${name}`
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(name)) continue
          walk(rel)
          continue
        }
        if (!entry.isFile()) continue
        if (detectLanguage(rel) === 'unknown') continue
        let size = 0
        try {
          size = statSync(join(this.root, rel)).size
        } catch {
          continue
        }
        if (size > MAX_FILE_BYTES) continue
        if (paths.length >= MAX_INDEX_FILES) {
          truncated = true
          return
        }
        paths.push(rel)
      }
    }
    walk('')
    return { paths, truncated }
  }

  /**
   * 只读当前快照查询（manager.py:267-305）；绝不触发构建。
   * 返回命中 chunk + 归一化得分（raw/max 钳 [0,1]，bm25.py:388-402）。
   */
  search(
    query: string,
    opts: { language?: string | undefined; pathPrefix?: string; maxResults?: number } = {},
  ): CodeChunkHit[] {
    const maxResults = Math.max(1, Math.min(opts.maxResults ?? 10, 50))
    const terms = queryTerms(query)
    if (terms.length === 0) return []

    const prefix = normalizePrefix(opts.pathPrefix ?? '.')
    const language = opts.language?.trim().toLowerCase() || undefined

    const docs: BM25Document[] = []
    const chunkById = new Map<string, RawChunk>()
    for (const [relPath, entry] of this.files) {
      if (prefix !== '' && relPath !== prefix && !relPath.startsWith(`${prefix}/`)) continue
      for (const [idx, chunk] of entry.chunks.entries()) {
        if (language !== undefined && chunk.language.toLowerCase() !== language) continue
        const tokens = chunkToDocTokens(chunk)
        const id = `${relPath}#${idx}`
        docs.push({ id, ...tokens })
        chunkById.set(id, chunk)
      }
    }
    if (docs.length === 0) return []

    const hits = normalizeScores(bm25Rank(docs, terms)).slice(0, maxResults)
    return hits.flatMap((hit) => {
      const chunk = chunkById.get(hit.id)
      return chunk === undefined ? [] : [{ chunk, score: hit.score }]
    })
  }
}

/** path_prefix 归一化（bm25.py:468-472；`.`/空/`/` 均视为根）。 */
export function normalizePrefix(pathPrefix: string): string {
  const p = (pathPrefix ?? '').trim().replace(/\\/g, '/')
  if (p === '' || p === '.' || p === './' || p === '/') return ''
  return p.replace(/^\/+/, '').replace(/\/+$/, '')
}

// ── 模块级缓存（任务规格：key=工作区根，内存即可，不持久化）────────────────

const indexCache = new Map<string, WorkspaceCodeIndex>()

/** 取（或建）某工作区根的索引管理器等价物。 */
export function getWorkspaceIndex(root: string): WorkspaceCodeIndex {
  let index = indexCache.get(root)
  if (index === undefined) {
    index = new WorkspaceCodeIndex(root)
    indexCache.set(root, index)
  }
  return index
}

/** 测试钩子：清空某工作区根（缺省全部）的索引缓存。 */
export function resetWorkspaceIndex(root?: string): void {
  if (root === undefined) indexCache.clear()
  else indexCache.delete(root)
}
