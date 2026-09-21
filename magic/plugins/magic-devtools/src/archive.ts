/**
 * archive_create / archive_extract —— 工作区 zip 打包与解包。
 *
 * 行为蓝本：AgentCore tools/builtin/archive_create.py（ ceilings 5000 文件 /
 * 200 MiB 原始字节、VCS/依赖目录剪枝）与 archive_extract.py（zip-bomb 顶、
 * zip-slip 拒绝、`archive` 须为工作区内 .zip）。用 fflate 纯 JS 实现。
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { zipSync, unzipSync, type Zippable } from 'fflate'

/** 与 AgentCore 对齐的打包顶。 */
export const CREATE_MAX_FILES = 5_000
export const CREATE_MAX_BYTES = 200 * 1024 * 1024
/** 解包单文件解压后上限（zip-bomb 顶，对齐 create 的 200 MiB 精神）。 */
export const EXTRACT_MAX_FILE_BYTES = 200 * 1024 * 1024

/** 打包时剪掉的目录名（对齐 AgentCore 的 VCS/依赖剪枝）。 */
const PRUNED_DIRS = new Set(['.git', 'node_modules'])

export interface CollectedFile {
  /** zip 内的相对路径（正斜杠）。 */
  arcPath: string
  absPath: string
  bytes: Uint8Array
}

/** 递归收集目录下的文件；越界 / 超顶即抛错。 */
export function collectSources(
  root: string,
  sources: readonly string[],
): CollectedFile[] {
  const files: CollectedFile[] = []
  let totalBytes = 0
  const seen = new Set<string>()

  const walkDir = (absDir: string, arcPrefix: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name)
      const arcPath = arcPrefix === '' ? entry.name : `${arcPrefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name)) continue
        walkDir(abs, arcPath)
      } else if (entry.isFile()) {
        if (seen.has(arcPath)) continue
        seen.add(arcPath)
        if (files.length >= CREATE_MAX_FILES) {
          throw new Error(`archive_create: 文件数超过上限 ${CREATE_MAX_FILES}`)
        }
        const bytes = readFileSync(abs)
        totalBytes += bytes.byteLength
        if (totalBytes > CREATE_MAX_BYTES) {
          throw new Error(`archive_create: 原始内容超过上限 ${CREATE_MAX_BYTES} 字节`)
        }
        files.push({ arcPath: arcPath.split(sep).join('/'), absPath: abs, bytes })
      }
    }
  }

  for (const source of sources) {
    const abs = resolve(root, source)
    if (!abs.startsWith(resolve(root))) {
      throw new Error(`archive_create: source \`${source}\` 超出工作区范围`)
    }
    const info = statSync(abs, { throwIfNoEntry: false })
    if (info === undefined) {
      throw new Error(`archive_create: source \`${source}\` 不存在`)
    }
    const arcPrefix = source.split(sep).join('/').replace(/\/$/, '')
    if (info.isDirectory()) walkDir(abs, arcPrefix)
    else {
      const bytes = readFileSync(abs)
      totalBytes += bytes.byteLength
      if (totalBytes > CREATE_MAX_BYTES) {
        throw new Error(`archive_create: 原始内容超过上限 ${CREATE_MAX_BYTES} 字节`)
      }
      files.push({ arcPath: arcPrefix, absPath: abs, bytes })
    }
  }
  if (files.length === 0) throw new Error('archive_create: 没有可打包的文件')
  return files
}

/** 打包为 zip 字节。 */
export function zipFiles(files: readonly CollectedFile[]): Uint8Array {
  const record: Zippable = {}
  for (const file of files) record[file.arcPath] = file.bytes
  return zipSync(record)
}

/** zip 条目路径安全检查：拒绝对路径与 `..` 逃逸（zip-slip）。 */
export function safeEntryName(root: string, destAbs: string, entryName: string): string {
  const normalized = entryName.split('\\').join('/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`archive_extract: 条目 \`${entryName}\` 是绝对路径，已拒绝（zip-slip）`)
  }
  const target = resolve(destAbs, normalized)
  if (!isInside(root, destAbs) || !isInside(destAbs, target)) {
    throw new Error(`archive_extract: 条目 \`${entryName}\` 逃逸目标目录，已拒绝（zip-slip）`)
  }
  return target
}

function isInside(parent: string, child: string): boolean {
  const withSep = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(withSep)
}

/** 解包 zip 字节到目标目录，返回写出文件数。 */
export function unzipInto(
  zipBytes: Uint8Array,
  destAbs: string,
): { fileCount: number; totalBytes: number } {
  const entries = unzipSync(zipBytes)
  let fileCount = 0
  let totalBytes = 0
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    if (bytes.byteLength > EXTRACT_MAX_FILE_BYTES) {
      throw new Error(`archive_extract: 条目 \`${name}\` 解压后 ${bytes.byteLength} 字节，超过单文件上限`)
    }
    const target = safeEntryName(destAbs, destAbs, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    fileCount += 1
    totalBytes += bytes.byteLength
  }
  if (fileCount === 0) throw new Error('archive_extract: 压缩包里没有文件')
  return { fileCount, totalBytes }
}
