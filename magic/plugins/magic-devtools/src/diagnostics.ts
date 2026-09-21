/**
 * code_diagnostics —— TS/JS 语言服务内环诊断
 * （蓝本 AgentCore tools/builtin/code_diagnostics.py 259 行 + write_diagnostics.py 143 行）。
 *
 * 诊断来源的选型（任务要求先核查 DSH lsp 面再定）：
 * 已核查 reference-project/deepseek-harness/packages/lsp/lsp/src/ —— `ctx.lsp`
 * seam（index.ts:16 declare module、types.ts:113 LspService）只暴露
 * goToDefinition / findReferences / goToImplementation / hover 四个操作
 * （index.ts:3-5 模块注释明确 "exposes exactly the four operations and no
 * JSON-RPC escape hatch"），**没有 diagnostics 查询**；且依赖 @deepseek-ai/*
 * 包（本插件铁律禁 import）。故走回退路线：在工作区根执行
 * `npx tsc --noEmit --pretty false`，解析诊断并按蓝本 markdown 呈现。
 *
 * 对齐点：
 * - paths 规范化去重、反斜杠转斜杠（code_diagnostics.py:54-65）；
 * - _format_full_output 的 markdown 结构（:68-119）：状态/路径数/error·warning
 *   计数 + 按文件 `### path` + `- line:col severity [code]: message`；
 * - write_diagnostics.py 的短块 format_diagnostics_block（:29-85）：errors 优先、
 *   每文件按 severity/行/列排序、cap 12 条；
 * - is_js_ts_path（write_diagnostics.py:18-26）与输出顶 _OUTPUT_LIMIT=12000
 *   （code_diagnostics.py:41）；
 * - tsc 不可用时诚实降级（"unavailable"，:74-81 风格），不伪装成功。
 */

import { spawnSync } from 'node:child_process'

/** 首发 TS/JS 面（write_diagnostics.py:18）。 */
export const JS_TS_SUFFIXES: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

export const DIAGNOSTICS_TIMEOUT_MS = 25_000
export const OUTPUT_LIMIT = 12_000
/** 短块 cap（write_diagnostics.py:52）。 */
export const SHORT_BLOCK_CAP = 12

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, information: 2, hint: 3 }

export interface DiagnosticItem {
  path: string
  line: number
  column: number
  severity: string
  code: string
  message: string
}

export function isJsTsPath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const lower = name.toLowerCase()
  return JS_TS_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

/** paths 规范化（code_diagnostics.py:54-65）：字符串化、去空、去重、反斜杠转斜杠。 */
export function normalizePaths(raw: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    const p = String(item ?? '').trim().replace(/\\/g, '/')
    if (p === '' || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** 解析 `tsc --pretty false` 单行：`path(line,col): severity TSxxxx: message`。 */
export function parseTscLine(line: string): DiagnosticItem | undefined {
  const match = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info|information)\s*(?:([A-Za-z]+\d+))?:\s*(.+)$/.exec(line.trim())
  if (match === null) return undefined
  const [, file, lineNo, colNo, severity, code, message] = match
  return {
    path: (file ?? '').replace(/\\/g, '/'),
    line: Number.parseInt(lineNo ?? '0', 10),
    column: Number.parseInt(colNo ?? '0', 10),
    severity: severity === 'information' ? 'information' : severity ?? 'error',
    code: code ?? '',
    message: (message ?? '').trim(),
  }
}

export interface DiagnosticsPayload {
  status: 'ok' | 'unavailable'
  reason?: string
  diagnostics: DiagnosticItem[]
}

/** 在工作区根执行 tsc --noEmit（--pretty false），返回诊断 payload。 */
export function collectTscDiagnostics(
  cwd: string,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): DiagnosticsPayload {
  const args = ['tsc', '--noEmit', '--pretty', 'false']
  const spawned = spawnSync('npx', args, {
    cwd,
    encoding: 'utf8',
    timeout: DIAGNOSTICS_TIMEOUT_MS,
    windowsHide: true,
    shell: process.platform === 'win32',
    signal,
  })
  if (spawned.error !== undefined && (spawned.error as NodeJS.ErrnoException).code !== undefined) {
    const code = (spawned.error as NodeJS.ErrnoException).code ?? ''
    // npx 缺失 / tsc 不可安装：诚实降级（蓝本 unavailable 语义）。
    return {
      status: 'unavailable',
      reason: `tsc 不可用（${code || String(spawned.error)}）；无语言服务通道时诚实降级`,
      diagnostics: [],
    }
  }
  const output = `${spawned.stdout ?? ''}\n${spawned.stderr ?? ''}`
  const requested = new Set(paths.map(p => p.replace(/\\/g, '/')))
  const diagnostics: DiagnosticItem[] = []
  for (const line of output.split('\n')) {
    const item = parseTscLine(line)
    if (item === undefined) continue
    // 归一为工作区相对路径后过滤到请求集合（蓝本按 named/landed 路径拉取）。
    let rel = item.path.replace(/\\/g, '/')
    const marker = cwd.replace(/\\/g, '/')
    if (marker !== '' && rel.toLowerCase().startsWith(`${marker.toLowerCase()}/`)) {
      rel = rel.slice(marker.length + 1)
    }
    if (requested.size > 0 && !requested.has(rel)) continue
    diagnostics.push({ ...item, path: rel })
  }
  // tsc 跑了但整体失败且一行都没解析出来（tsconfig 缺失/npx 环境异常）：
  // 不许伪装成「无诊断项」，按蓝本 unavailable 诚实降级。
  if (diagnostics.length === 0 && spawned.status !== 0) {
    const tail = output.trim().split('\n').slice(-3).join(' ').trim()
    return {
      status: 'unavailable',
      reason: `tsc 退出码 ${String(spawned.status)}${tail !== '' ? `：${tail.slice(0, 300)}` : ''}`,
      diagnostics: [],
    }
  }
  return { status: 'ok', diagnostics }
}

/** 全量 markdown 呈现（code_diagnostics.py:68-119 _format_full_output）。 */
export function formatFullOutput(payload: DiagnosticsPayload, paths: readonly string[]): string {
  if (payload.status === 'unavailable') {
    const detail = payload.reason?.trim() || '语言服务不可用'
    return (
      `内环诊断不可用：${detail}\n`
      + '说明：无语言服务通道时诚实降级；'
      + '验收请用 run（typecheck/build/test）。'
      + (paths.length > 0 ? `\n请求路径：${paths.join(', ')}` : '')
    )
  }
  const items = payload.diagnostics
  const errors = items.filter(item => ['error', 'err'].includes((item.severity ?? '').toLowerCase()))
  const warnings = items.filter(item => ['warning', 'warn'].includes((item.severity ?? '').toLowerCase()))
  const lines = [
    '## 内环诊断（code_diagnostics）',
    '',
    '- 状态：ok',
    `- 路径数：${String(paths.length)}`,
    `- error：${String(errors.length)} · warning：${String(warnings.length)}`,
  ]
  if (items.length === 0) {
    lines.push('')
    lines.push('无诊断项（语言服务未报错/警告，或路径无 TS/JS 诊断）。')
    return lines.join('\n')
  }
  const byFile = new Map<string, DiagnosticItem[]>()
  for (const item of items) {
    const key = item.path || '?'
    const bucket = byFile.get(key)
    if (bucket === undefined) byFile.set(key, [item])
    else bucket.push(item)
  }
  for (const [filePath, diags] of byFile) {
    lines.push('', `### \`${filePath}\``)
    for (const diag of diags) {
      const severity = diag.severity || 'info'
      const loc = diag.line !== 0 ? `${String(diag.line)}:${String(diag.column)}` : '?'
      const codeBit = diag.code !== '' ? ` [${diag.code}]` : ''
      const message = diag.message.trim() || '(no message)'
      lines.push(`- ${loc} ${severity}${codeBit}: ${message}`)
    }
  }
  return lines.join('\n')
}

/** 写盘回执用的短块（write_diagnostics.py:29-85 format_diagnostics_block）。 */
export function formatDiagnosticsBlock(
  payload: DiagnosticsPayload,
  pathHint?: string,
): string {
  if (payload.status === 'unavailable') {
    const detail = payload.reason?.trim() || '语言服务不可用'
    return `\n内环诊断不可用：${detail}（验收请用 run）`
  }
  const items = payload.diagnostics
  const errors = items.filter(item => ['error', 'err'].includes((item.severity ?? '').toLowerCase()))
  const show = errors
  const headerPath = pathHint ?? show[0]?.path
  if (show.length === 0) {
    const label = headerPath !== undefined ? `\`${headerPath}\` ` : ''
    return `\n内环诊断：${label}无 error`
  }
  const lines = ['', '内环诊断（code_diagnostics）：']
  const byFile = new Map<string, DiagnosticItem[]>()
  for (const diag of show) {
    const key = diag.path || headerPath || '?'
    const bucket = byFile.get(key)
    if (bucket === undefined) byFile.set(key, [diag])
    else bucket.push(diag)
  }
  let shown = 0
  for (const [filePath, diags] of byFile) {
    lines.push(`- \`${filePath}\``)
    const sorted = [...diags].sort((a, b) =>
      (SEVERITY_ORDER[(a.severity ?? '').toLowerCase()] ?? 9) - (SEVERITY_ORDER[(b.severity ?? '').toLowerCase()] ?? 9)
      || a.line - b.line
      || a.column - b.column)
    for (const diag of sorted) {
      if (shown >= SHORT_BLOCK_CAP) {
        const remaining = show.length - shown
        lines.push(`  …另有 ${String(remaining)} 条 error 省略；可再调 code_diagnostics 看全部`)
        return lines.join('\n')
      }
      const loc = diag.line !== 0 ? `${String(diag.line)}:${String(diag.column)}` : '?'
      const codeBit = diag.code !== '' ? ` [${diag.code}]` : ''
      const message = diag.message.trim() || '(no message)'
      lines.push(`  · ${loc} error${codeBit}: ${message}`)
      shown += 1
    }
  }
  return lines.join('\n')
}

// ── 工具层 ─────────────────────────────────────────────────────────────────

export interface DiagnosticsToolDeps {
  register(tool: {
    name: string
    description: string
    parameters: unknown
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown, exec?: unknown) => Promise<unknown>
  }): unknown
}

function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function workspaceRootOf(exec: unknown): string {
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)
    ?.agent?.session?.header?.cwd
  if (cwd === undefined || cwd.trim() === '') {
    throw new Error('devtools: 无法确定会话工作区（exec.agent.session.header.cwd 缺失）')
  }
  return cwd
}

/** 注册 code_diagnostics 工具。 */
export function registerCodeDiagnostics(tools: DiagnosticsToolDeps): void {
  tools.register({
    name: 'code_diagnostics',
    description:
      '内环 TS/JS 诊断：对指定路径执行 tsc --noEmit --pretty false 并按文件呈现 error/warning'
      + '（对齐 AgentCore code_diagnostics；DSH ctx.lsp 不暴露 diagnostics，故走 tsc 回退）。'
      + '写盘后的主动复查用本工具；验收用外环 run（typecheck/build/test）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '工作区相对路径列表（TS/JS 源文件）。',
        },
      },
      required: ['paths'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: unknown, exec?: unknown) {
      const root = workspaceRootOf(exec)
      const raw = (args ?? {}) as { paths?: unknown }
      const paths = normalizePaths(raw.paths)
      if (paths.length === 0) {
        throw new Error('code_diagnostics: paths 不能为空（工作区相对路径数组）')
      }
      // 越界拒绝：绝对路径 / `..` 逃逸一律拒绝（对齐 paths.ts 语义）。
      for (const rel of paths) {
        if (/^([A-Za-z]:|\\\\|\/)/.test(rel)) {
          throw new Error(`code_diagnostics: 路径须为工作区相对路径（收到绝对路径 \`${rel}\`）`)
        }
        if (rel.split('/').includes('..')) {
          throw new Error(`code_diagnostics: 路径 \`${rel}\` 超出工作区范围`)
        }
      }
      const payload = collectTscDiagnostics(root, paths, undefined)
      const text = formatFullOutput(payload, paths)
      return text.length > OUTPUT_LIMIT
        ? `${text.slice(0, OUTPUT_LIMIT)}\n…（诊断输出超过 ${OUTPUT_LIMIT} 字符已截断）`
        : text
    },
  })
}
