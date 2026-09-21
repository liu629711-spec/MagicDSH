/**
 * magic-devtools —— 开发者工具集（第一梯队 #6）。
 *
 * 行为蓝本：AgentCore tools/builtin/{archive_create,archive_extract,git_ops/,
 * package_install.py,code_search.py,code_diagnostics.py,write_diagnostics.py}，
 * 复刻规格见 docs/02-实现/06-开发者工具集复刻规格.md。
 * 工作区根 = 会话 cwd（exec.agent.session.header.cwd，DSH 原生约定）；
 * 一期交付 archive_create / archive_extract / git_ops 三个工具，
 * 二期追加 package_install / code_search / code_diagnostics（规格 §3-§5）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { collectSources, unzipInto, zipFiles } from './archive.ts'
import { runGit } from './git.ts'
import { registerCodeSearch } from './code-search/index.ts'
import { registerCodeDiagnostics } from './diagnostics.ts'
import { registerPackageInstall } from './package-install.ts'
import { resolveInWorkspace } from './paths.ts'

export const name = 'magic-devtools'

export const inject = ['tools']

type ToolExec = {
  agent?: { session?: { header?: { cwd?: string } } }
  signal?: AbortSignal
} | undefined

interface ToolsService {
  register(tool: {
    name: string
    description: string
    parameters: unknown
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown, exec?: ToolExec) => Promise<unknown> | unknown
  }): unknown
}

interface DevtoolsContext {
  tools: ToolsService
}

function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

/** 从 exec 取会话工作区根（缺失时给出可读报错）。 */
function workspaceRoot(exec: ToolExec): string {
  const cwd = exec?.agent?.session?.header?.cwd
  if (cwd === undefined || cwd.trim() === '') {
    throw new Error('devtools: 无法确定会话工作区（exec.agent.session.header.cwd 缺失）')
  }
  return cwd
}

export async function apply(ctx: DevtoolsContext): Promise<void> {
  // ── archive_create：打包工作区文件/目录为 .zip ─────────────────────────
  ctx.tools.register({
    name: 'archive_create',
    description:
      '把工作区内的文件/目录打包为一个 .zip（对齐 AgentCore archive_create）。'
      + '自动剪枝 .git/ 与 node_modules/；上限 5000 文件 / 200 MiB 原始内容。'
      + 'sources 与 dest 都必须是工作区相对路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: '要打包的文件或目录（工作区相对路径，可多个）。',
        },
        dest: {
          type: 'string',
          description: '输出的 .zip 路径（工作区相对路径，须以 .zip 结尾）。',
        },
      },
      required: ['sources', 'dest'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    execute(args: unknown, exec?: ToolExec) {
      const root = workspaceRoot(exec)
      const raw = (args ?? {}) as { sources?: unknown; dest?: unknown }
      const sources = Array.isArray(raw.sources)
        ? raw.sources.filter((item): item is string => typeof item === 'string')
        : []
      if (sources.length === 0) throw new Error('archive_create: sources 不能为空')
      const dest = typeof raw.dest === 'string' ? raw.dest.trim() : ''
      if (dest === '' || !dest.toLowerCase().endsWith('.zip')) {
        throw new Error('archive_create: dest 须为工作区内以 .zip 结尾的相对路径')
      }
      const destAbs = resolveInWorkspace(root, dest, 'dest')
      const files = collectSources(root, sources)
      const zip = zipFiles(files)
      mkdirSync(dirname(destAbs), { recursive: true })
      writeFileSync(destAbs, zip)
      return `已打包 ${String(files.length)} 个文件（${String(zip.byteLength)} 字节）→ ${dest}`
    },
  })

  // ── archive_extract：解包工作区 .zip ──────────────────────────────────
  ctx.tools.register({
    name: 'archive_extract',
    description:
      '解压工作区内的 .zip 到目标目录（对齐 AgentCore archive_extract）。'
      + '拒绝 zip-slip（条目逃逸目标目录/绝对路径）并设 zip-bomb 单文件顶。'
      + 'archive 须为工作区内已有 .zip；dest 为解压目标目录（`.` 表示工作区根）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        archive: { type: 'string', description: '工作区内的 .zip 相对路径（如 uploads/pkg.zip）。' },
        dest: { type: 'string', description: '解压目标目录（工作区相对路径；`.` 表示工作区根）。' },
      },
      required: ['archive', 'dest'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    execute(args: unknown, exec?: ToolExec) {
      const root = workspaceRoot(exec)
      const raw = (args ?? {}) as { archive?: unknown; dest?: unknown }
      const archive = typeof raw.archive === 'string' ? raw.archive.trim() : ''
      const dest = typeof raw.dest === 'string' ? raw.dest.trim() : ''
      if (archive === '' || !archive.toLowerCase().endsWith('.zip')) {
        throw new Error('archive_extract: archive 须为工作区内的 .zip 相对路径')
      }
      if (dest === '') throw new Error('archive_extract: dest 不能为空（可用 `.` 表示工作区根）')
      const archiveAbs = resolveInWorkspace(root, archive, 'archive')
      const destAbs = resolveInWorkspace(root, dest, 'dest')
      const zipBytes = readFileSync(archiveAbs)
      const { fileCount, totalBytes } = unzipInto(new Uint8Array(zipBytes), destAbs)
      return `已解压 ${String(fileCount)} 个文件（共 ${String(totalBytes)} 字节）→ ${dest}`
    },
  })

  // ── git_ops：白名单 git 子命令 ────────────────────────────────────────
  ctx.tools.register({
    name: 'git_ops',
    description:
      '在工作区内执行白名单 git 子命令（对齐 AgentCore git_ops）。'
      + '允许：status diff log fetch show blame add commit branch checkout push pull clone stash merge rebase cherry-pick tag remote init_baseline create_pr。'
      + '硬禁 reset / clean；push/merge/pull 拒 --force；git add 拒收 . / -A / --all（须列明确路径）；'
      + 'create_pr 二期开放。单次调用 20s 超时，diff 16k 字符截断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subcommand: { type: 'string', description: 'git 子命令（须在白名单内）。' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '子命令参数（不含 git 本身与子命令名）。',
        },
      },
      required: ['subcommand'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    execute(args: unknown, exec?: ToolExec) {
      const root = workspaceRoot(exec)
      const raw = (args ?? {}) as { subcommand?: unknown; args?: unknown }
      const subcommand = typeof raw.subcommand === 'string' ? raw.subcommand.trim() : ''
      if (subcommand === '') throw new Error('git_ops: subcommand 不能为空')
      const gitArgs = Array.isArray(raw.args) ? raw.args.filter((item): item is string => typeof item === 'string') : []
      const result = runGit(root, subcommand, gitArgs, exec?.signal)
      if (!result.ok) throw new Error(result.output)
      return result.output
    },
  })

  // ── 二期：package_install / code_search / code_diagnostics ─────────────
  registerPackageInstall(ctx.tools)
  registerCodeSearch(ctx.tools)
  registerCodeDiagnostics(ctx.tools)
}
