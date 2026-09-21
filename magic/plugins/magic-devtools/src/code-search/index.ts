/**
 * code_search 工具 —— BM25 符号级代码搜索
 * （蓝本 AgentCore tools/builtin/code_search.py，255 行）。
 *
 * 对齐点：query 必填；max_results 默认 10、硬顶 50（:27-28）；可选 language /
 * path_prefix 过滤；输出「符号 chunk + 文件:行号 + 得分」markdown（:154-191）；
 * 空结果给可行动提示 + grep 关键词建议（:194-255）；状态页脚（READY 无、
 * BUILDING 促 grep、STALE 提醒过旧）。
 */

import { getWorkspaceIndex, type CodeChunkHit, type CodeIndexStatus } from './manager.ts'
import { snippetPreview } from './chunker.ts'
import { tokenizeQuery } from './tokenize.ts'

export const DEFAULT_MAX_RESULTS = 10
export const MAX_RESULTS_CAP = 50
export const OUTPUT_LIMIT = 16_000

export interface CodeSearchToolDeps {
  register(tool: {
    name: string
    description: string
    parameters: unknown
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown, exec?: unknown) => Promise<unknown> | unknown
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

/** 注册 code_search 工具（查询时自动建/增量刷新索引，查询只读快照）。 */
export function registerCodeSearch(tools: CodeSearchToolDeps): void {
  tools.register({
    name: 'code_search',
    description:
      '按概念/意图搜索工作区代码（tree-sitter 符号块 + BM25 排序，对齐 AgentCore code_search）。'
      + '精确符号、字符串或正则用 grep。'
      + `max_results 默认 ${DEFAULT_MAX_RESULTS}，最多 ${MAX_RESULTS_CAP}。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '概念 / 意图查询（自然语言或关键词，如「审批门控」「User model」）。' },
        language: { type: 'string', description: '可选：按语言过滤，如 python、typescript、tsx、javascript。' },
        path_prefix: {
          type: 'string',
          description: '搜索范围：工作区相对 POSIX 目录前缀（默认 `.`=整仓）。禁止绝对路径。',
        },
        max_results: { type: 'integer', description: `返回的最大结果数（默认 ${DEFAULT_MAX_RESULTS}，最多 ${MAX_RESULTS_CAP}）。` },
      },
      required: ['query'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: unknown, exec?: unknown) {
      const root = workspaceRootOf(exec)
      const raw = (args ?? {}) as {
        query?: unknown
        language?: unknown
        path_prefix?: unknown
        max_results?: unknown
      }
      const query = typeof raw.query === 'string' ? raw.query.trim() : ''
      if (query === '') throw new Error('code_search: 缺少必填参数：query')

      let maxResults = DEFAULT_MAX_RESULTS
      if (typeof raw.max_results === 'number' && Number.isFinite(raw.max_results)) {
        maxResults = Math.max(1, Math.min(Math.floor(raw.max_results), MAX_RESULTS_CAP))
      }
      const language = typeof raw.language === 'string' && raw.language.trim() !== '' ? raw.language.trim() : undefined
      const pathPrefix = typeof raw.path_prefix === 'string' && raw.path_prefix.trim() !== '' ? raw.path_prefix.trim() : '.'
      if (/^([A-Za-z]:|\\\\|\/)/.test(pathPrefix.replace(/\\/g, '/').replace(/^\.\//, '')) && pathPrefix.replace(/\\/g, '/') !== '/') {
        throw new Error(`code_search: path_prefix 须为工作区相对前缀（收到绝对路径 \`${pathPrefix}\`）`)
      }

      const index = getWorkspaceIndex(root)
      // 首查自动建索引 / 变更后增量刷新（蓝本由 IndexMaintainer 后台做，Magic 同步做）。
      await index.ensureAsync()
      const hits = index.search(query, { language, pathPrefix, maxResults })
      return renderSearch(hits, {
        query,
        pathPrefix,
        status: index.status,
      })
    },
  })
}

export function renderSearch(
  hits: readonly CodeChunkHit[],
  renderInfo: { query: string; pathPrefix: string; status: CodeIndexStatus },
): string {
  // 局部变量名不用 ctx：契约体检把 `ctx.<成员>` 一律当 Cordis 服务访问扫描。
  if (hits.length === 0) {
    return emptyResultNote(renderInfo.query, { pathPrefix: renderInfo.pathPrefix, status: renderInfo.status })
  }
  const lines: string[] = []
  for (const { chunk, score } of hits) {
    let symbolPart = ''
    if (chunk.symbol !== null) {
      symbolPart = `  ${chunk.symbol}`
      if (chunk.symbolType !== null) symbolPart += ` (${chunk.symbolType})`
    }
    const header = `${chunk.path}:${String(chunk.startLine)}-${String(chunk.endLine)}${symbolPart} (${chunk.language})`
    const preview = snippetPreview(chunk.content).replace(/\n/g, '\n  ')
    lines.push(`${header}\n  ${preview}\n  score=${score.toFixed(2)}`)
  }
  const summary = `（共 ${String(hits.length)} 条结果；要看整文件请用带行号的文件读取）`
  return `${lines.join('\n\n')}\n\n${summary}${statusFooter(renderInfo.status)}`
}

function statusFooter(status: CodeIndexStatus): string {
  if (status === 'READY') return ''
  if (status === 'BUILDING') return '\n⚠️ 代码索引尚无可用快照（首次构建中）；请改用 grep，勿空等。'
  return '\n⚠️ 索引可能过旧或不完整，建议配合 grep 验证。'
}

function emptyResultNote(
  query: string,
  renderInfo: { pathPrefix: string; status: CodeIndexStatus },
): string {
  /** 空结果也给可行动提示（code_search.py:194-227）。 */
  const scope = renderInfo.pathPrefix === '' || renderInfo.pathPrefix === '.' ? '' : `（path_prefix='${renderInfo.pathPrefix}'）`
  const keywords = grepKeywordSuggestions(query)
  const kwLine = keywords.length === 0
    ? ''
    : `建议用 grep 精确搜这些关键词：${keywords.map(k => `\`${k}\``).join('、')}。`

  if (renderInfo.status === 'BUILDING') {
    return (
      `代码索引尚无可用快照（首次构建中）${scope}，本次无可用命中。`
      + `请立刻改用 grep（精确符号/字符串），不要空等 code_search。`
      + `${kwLine}`
    )
  }
  const tips = (
    '可执行下一步：① 收窄或放宽 path_prefix / 去掉 language 过滤；'
    + '② 换更短的概念词或同义改写后再 code_search；'
    + '③ 若目标是确切符号/字符串，改用 grep；'
    + '④ 确认 path_prefix 相对工作区根且存在。'
  )
  let body = `本次 code_search 未命中任何代码块${scope}。不要据此断定代码不存在。${kwLine}${tips}`
  if (renderInfo.status === 'STALE') body += ' ⚠️ 索引可能过旧或不完整，建议直接用 grep 验证。'
  return body
}

/** 标识符类 token 优先作为 grep 建议（code_search.py:230-255）。 */
export function grepKeywordSuggestions(query: string, limit: number = 5): string[] {
  const tokens = tokenizeQuery(query)
  const ranked: Array<{ score: number; token: string }> = tokens.map((token) => {
    let score: number
    const head = token[0] ?? ''
    const rest = token.slice(1)
    if (token.includes('_') || (/[A-Z]/.test(rest) && /[A-Za-z]/.test(head))) {
      // snake / Camel 标识符优先于纯 CJK bigram。
      score = 3
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      score = 2
    } else if (/^[\u4e00-\u9fff]+$/.test(token) && token.length >= 2) {
      score = 1
    } else {
      score = 1
    }
    return { score, token }
  })
  ranked.sort((a, b) => b.score - a.score || b.token.length - a.token.length)
  const out: string[] = []
  for (const { token } of ranked) {
    if (!out.includes(token)) out.push(token)
    if (out.length >= limit) break
  }
  return out
}
