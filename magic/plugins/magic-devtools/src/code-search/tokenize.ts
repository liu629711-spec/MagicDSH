/**
 * 查询/文档词法 —— 对齐 AgentCore workspace/indexing/bm25.py:16-18（_QUERY_TOKEN）
 * 与 :432-457（tokenize_query / _expand_token）。
 *
 * 语义：标识符（foo_bar、ApprovalGate）保持完整；相邻 CJK 与 Latin 分开；
 * 较长中文串额外产出重叠 bigram，保证中文短语部分命中。文档侧用同一词法
 * （FTS5 unicode61 的 JS 等价投影），保证查询 token 与索引 token 同构可比分。
 */

const QUERY_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fff]+|[0-9]+/g

/** 中文串（≥2 字）追加重叠 bigram（bm25.py:449-457）。 */
function expandToken(token: string): string[] {
  const out = [token]
  if (token.length >= 2 && /^[\u4e00-\u9fff]+$/.test(token)) {
    for (let i = 0; i < token.length - 1; i += 1) {
      const bigram = token.slice(i, i + 2)
      if (bigram !== token) out.push(bigram)
    }
  }
  return out
}

/** 自然语言 / 中英混排查询 → FTS token 序列（去重保序）。 */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const raw of (query ?? '').match(QUERY_TOKEN_RE) ?? []) {
    for (const piece of expandToken(raw)) {
      if (!seen.has(piece)) {
        seen.add(piece)
        tokens.push(piece)
      }
    }
  }
  return tokens
}

/** 文档字段词法：与查询同一词法（小写归一，保证 case-insensitive 召回）。 */
export function tokenizeDoc(text: string): string[] {
  return ((text ?? '').match(QUERY_TOKEN_RE) ?? []).map(token => token.toLowerCase())
}

/** 查询侧：token 全部 OR 召回（bm25.py:460-465 的 FTS OR 语义）。 */
export function queryTerms(query: string): string[] {
  return tokenizeQuery(query).map(token => token.toLowerCase())
}
