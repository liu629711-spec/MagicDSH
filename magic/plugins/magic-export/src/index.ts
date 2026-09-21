/**
 * magic-export 插件入口：name / inject / apply。
 *
 * 行为蓝本：AgentCore tools/builtin/{md_to_docx,md_to_pdf}.py +
 * docs_export/{workspace_export,layout}.py（逐项对齐：参数、输出口径、错误消息）。
 * 蓝本是两个独立工具（md_to_docx / md_to_pdf），这里同样注册两个同名工具：
 * 入参只有 path（工作区内 .md/.markdown 相对路径）与 layout 档位，输出为同目录同名
 * .docx / .pdf（蓝本 docx_path_for_markdown / pdf_path_for_markdown 的兄弟文件规则）。
 *
 * 不 import 任何 @deepseek-ai/*：宿主服务鸭子类型，工作区根取
 * exec.agent.session.header.cwd（DSH 原生约定），路径 helpers 复制自 magic-devtools。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { convertMarkdownToDocx } from './md-to-docx.ts'
import { convertMarkdownToPdf } from './md-to-pdf.ts'
import {
  LAYOUT_INVALID_MESSAGE,
  LAYOUT_PARAM_DESCRIPTION,
  DOC_LAYOUTS,
  LAYOUT_STANDARD,
  parseLayout,
} from './layout.ts'
import {
  collectImageSrcs,
  docxPathForMarkdown,
  isEmbeddableRelativeSrc,
  parseMarkdown,
  pdfPathForMarkdown,
  resolveWorkspaceImagePath,
} from './markdown.ts'
import { isInside, resolveInWorkspace, workspaceRootOf, type ExportExec } from './paths.ts'

export const name = 'magic-export'

/** Cordis 服务名（不是包名）。 */
export const inject = ['tools']

type ToolExec = ExportExec | undefined

interface ToolsService {
  register(tool: {
    name: string
    description: string
    parameters: unknown
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown, exec?: ToolExec) => Promise<unknown>
  }): unknown
}

interface ExportContext {
  tools: ToolsService
}

export interface ExportResult {
  /** 产物的路径（工作区相对路径，`/` 分隔）。 */
  path: string
  /** 源 Markdown 的工作区相对路径。 */
  source: string
  bytes: number
  warnings: string[]
  /** 回执 manifest 文本（蓝本 execute 的 output 文案）。 */
  manifest: string
}

function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const result = value as ExportResult | undefined
  const text = result !== undefined && typeof result.manifest === 'string'
    ? result.manifest
    : JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** 蓝本 workspace_export._normalize_md_path。 */
function normalizeMdPath(mdPath: unknown): string {
  const raw = typeof mdPath === 'string' ? mdPath : String(mdPath ?? '')
  const rel = raw.replaceAll('\\', '/').trim().replace(/^\/+/, '')
  if (rel === '') {
    throw new Error('path 不能为空：请提供工作区内的 .md 相对路径')
  }
  const lower = rel.toLowerCase()
  if (!(lower.endsWith('.md') || lower.endsWith('.markdown'))) {
    throw new Error(`仅支持 Markdown 文件（.md / .markdown）：${rel}`)
  }
  return rel
}

/** 蓝本 workspace_export._read_markdown 的错误口径（源在会话工作区内解析）。 */
function readMarkdownSource(root: string, rel: string): string {
  let abs: string
  try {
    abs = resolveInWorkspace(root, rel, 'path')
  } catch {
    throw new Error('路径非法：超出工作区范围')
  }
  let stats
  try {
    stats = statSync(abs)
  } catch {
    throw new Error(`源文件不存在：${rel}`)
  }
  if (!stats.isFile()) throw new Error(`不是文件：${rel}`)
  return readFileSync(abs, 'utf8')
}

/** 输出兄弟文件；目录不存在则创建（蓝本 backend.write_bytes 的落盘语义）。 */
function writeOutput(root: string, outRel: string, bytes: Uint8Array): number {
  const abs = resolveInWorkspace(root, outRel, 'output')
  if (!isInside(root, abs)) throw new Error('输出路径非法：超出工作区范围')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return bytes.byteLength
}

function buildManifest(
  kind: 'docx' | 'pdf',
  outRel: string,
  sourceRel: string,
  bytes: number,
  warnings: string[],
): string {
  const lines = [
    `${kind === 'docx' ? '已导出 Word' : '已导出 PDF'}：${outRel}（${String(bytes)} 字节）`,
    '【artifact manifest】',
    `path: ${outRel}`,
    `kind: ${kind}`,
    `bytes: ${String(bytes)}`,
    `source: ${sourceRel}`,
  ]
  if (warnings.length > 0) {
    lines.push('warnings:')
    lines.push(...warnings.map((w) => `  - ${w}`))
  } else {
    lines.push('warnings: （无）')
  }
  lines.push(`【验真】请以本 manifest 确认落盘；可用工作区下载打开 .${kind}。`)
  return lines.join('\n')
}

/** 蓝本 md_to_docx：读源、解析相对路径图片字节、转 docx、写兄弟文件、出自报 manifest。 */
async function runDocxExport(root: string, args: Record<string, unknown>): Promise<ExportResult> {
  const layout = parseLayout(args.layout)
  if (layout === null) throw new Error(LAYOUT_INVALID_MESSAGE)
  const rel = normalizeMdPath(args.path)
  const markdown = readMarkdownSource(root, rel)

  // 蓝本 workspace_export.export_markdown_path：可嵌入的相对路径图片先查字节，缺了记 null。
  const images: Record<string, Uint8Array | null> = {}
  for (const src of collectImageSrcs(parseMarkdown(markdown))) {
    if (!isEmbeddableRelativeSrc(src)) continue
    const wsImg = resolveWorkspaceImagePath(rel, src)
    if (wsImg === null) {
      images[src] = null
      continue
    }
    try {
      const absImg = resolveInWorkspace(root, wsImg, 'image')
      images[src] = existsSync(absImg) ? new Uint8Array(readFileSync(absImg)) : null
    } catch {
      images[src] = null
    }
  }

  const result = await convertMarkdownToDocx(markdown, { images, layout })
  const outRel = docxPathForMarkdown(rel)
  const bytes = writeOutput(root, outRel, result.docxBytes)
  return {
    path: outRel,
    source: rel,
    bytes,
    warnings: result.warnings,
    manifest: buildManifest('docx', outRel, rel, bytes, result.warnings),
  }
}

/** 蓝本 md_to_pdf：读源、转 pdf、写兄弟文件、出自报 manifest。 */
async function runPdfExport(root: string, args: Record<string, unknown>): Promise<ExportResult> {
  const layout = parseLayout(args.layout)
  if (layout === null) throw new Error(LAYOUT_INVALID_MESSAGE)
  const rel = normalizeMdPath(args.path)
  const markdown = readMarkdownSource(root, rel)

  const result = await convertMarkdownToPdf(markdown, { layout })
  const outRel = pdfPathForMarkdown(rel)
  const bytes = writeOutput(root, outRel, result.pdfBytes)
  return {
    path: outRel,
    source: rel,
    bytes,
    warnings: result.warnings,
    manifest: buildManifest('pdf', outRel, rel, bytes, result.warnings),
  }
}

const TOOL_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description: '工作区内的 Markdown 相对路径（如 `docs/报告.md`）',
    },
    layout: {
      type: 'string',
      enum: [...DOC_LAYOUTS],
      default: LAYOUT_STANDARD,
      description: LAYOUT_PARAM_DESCRIPTION,
    },
  },
  required: ['path'],
}

export async function apply(ctx: ExportContext): Promise<void> {
  // ── md_to_docx：Markdown → 同目录同名 .docx（蓝本同名工具） ────────────
  ctx.tools.register({
    name: 'md_to_docx',
    description:
      '把工作区内的 Markdown 文件确定性导出为同目录同名 Word（.docx）。'
      + '例：`报告.md` → `报告.docx`。覆盖标题 #–####、段落、有序/无序列表、'
      + '表格、围栏代码、相对路径图片（嵌入）与链接；缺图会在回执中明确警告。'
      + '路径必须是相对于工作区的 .md / .markdown 相对路径。',
    parameters: TOOL_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          source: { type: 'string' },
          bytes: { type: 'number' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'source', 'bytes', 'warnings'],
      },
      render: textRender,
    },
    async execute(args: unknown, exec?: ToolExec) {
      const root = workspaceRootOf(exec)
      return runDocxExport(root, (args ?? {}) as Record<string, unknown>)
    },
  })

  // ── md_to_pdf：Markdown → 同目录同名 .pdf（蓝本同名工具） ──────────────
  ctx.tools.register({
    name: 'md_to_pdf',
    description:
      '把工作区内的 Markdown 文件确定性导出为同目录同名 PDF（.pdf）。'
      + '例：`报告.md` → `报告.pdf`。覆盖标题 #–####、段落、有序/无序列表、'
      + '表格与围栏代码；中文依赖系统/Noto CJK 字体，缺字体时回执明确警告。'
      + '路径必须是相对于工作区的 .md / .markdown 相对路径。',
    parameters: TOOL_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          source: { type: 'string' },
          bytes: { type: 'number' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'source', 'bytes', 'warnings'],
      },
      render: textRender,
    },
    async execute(args: unknown, exec?: ToolExec) {
      const root = workspaceRootOf(exec)
      return runPdfExport(root, (args ?? {}) as Record<string, unknown>)
    },
  })
}
