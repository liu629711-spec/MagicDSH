/**
 * BM25 打分器 —— 对齐 AgentCore workspace/indexing/bm25.py 的打分语义。
 *
 * 蓝本把 chunk 存进 SQLite FTS5（bm25.py:57-66），列权重
 * `_BM25_WEIGHTS = bm25(chunks, 1.0, 10.0, 5.0, 1.0, 1.0, 1.0, 1.0)`（:23）：
 * symbol=10.0、symbol_type=5.0、content=1.0，path/language/行号列不索引。
 * Magic 侧没有 SQLite，这里实现同构的字段加权 BM25：
 *
 *   tf_w(t,d) = Σ_f w_f · count_f(t)
 *   idf(t)    = ln((N − n_t + 0.5) / (n_t + 0.5))，≤0 时钳到 1e-6（FTS5 行为）
 *   score(d)  = Σ_{t∈query} idf · tf_w·(k1+1) / (tf_w + k1·(1 − b + b·|d|/avgdl))
 *
 * k1=1.2、b=0.75（FTS5 默认）。查询 token 全部按 OR 召回（bm25.py:460-465）。
 * 归一化（raw/max 钳到 [0,1]）发生在蓝本 bm25.py:388-402 的 search 层，
 * 本模块只产出 raw 分，归一化放在 manager。
 */

export const BM25_K1 = 1.2
export const BM25_B = 0.75

/** 字段权重（bm25.py:23 的 _BM25_WEIGHTS 投影；0 = UNINDEXED）。 */
export const BM25_FIELD_WEIGHTS = {
  symbol: 10.0,
  symbolType: 5.0,
  content: 1.0,
} as const

/** 一个可打分的预分词文档（字段 token 序列已由 tokenizeDoc 产出）。 */
export interface BM25Document {
  readonly id: string
  readonly symbol: readonly string[]
  readonly symbolType: readonly string[]
  readonly content: readonly string[]
}

export interface BM25Hit {
  readonly id: string
  readonly score: number
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/** 文档总 token 数（全部索引字段合计，等价 FTS5 的 row 长度 D）。 */
export function docLength(doc: BM25Document): number {
  return doc.symbol.length + doc.symbolType.length + doc.content.length
}

/**
 * 对文档集合按查询 token 打 BM25 分，降序返回（只含至少命中一个词的文档）。
 * O(N·terms)，文档由调用方按 workspace 快照提供。
 */
export function bm25Rank(
  docs: readonly BM25Document[],
  terms: readonly string[],
  opts: { k1?: number; b?: number } = {},
): BM25Hit[] {
  const k1 = opts.k1 ?? BM25_K1
  const b = opts.b ?? BM25_B
  const uniqueTerms = [...new Set(terms)]
  if (uniqueTerms.length === 0 || docs.length === 0) return []

  const n = docs.length
  const avgdl = docs.reduce((sum, doc) => sum + docLength(doc), 0) / n
  if (avgdl <= 0) return []

  // 预分词：每文档字段的 token 计数。
  const prepared = docs.map((doc) => ({
    id: doc.id,
    doc,
    symbol: countTokens(doc.symbol),
    symbolType: countTokens(doc.symbolType),
    content: countTokens(doc.content),
  }))

  // df(t)：含 t 的文档数。
  const df = new Map<string, number>()
  for (const term of uniqueTerms) {
    let count = 0
    for (const entry of prepared) {
      const tf =
        10.0 * (entry.symbol.get(term) ?? 0)
        + 5.0 * (entry.symbolType.get(term) ?? 0)
        + 1.0 * (entry.content.get(term) ?? 0)
      if (tf > 0) count += 1
    }
    df.set(term, count)
  }

  const hits: BM25Hit[] = []
  for (const entry of prepared) {
    const d = docLength(entry.doc)
    let score = 0
    for (const term of uniqueTerms) {
      const tf =
        BM25_FIELD_WEIGHTS.symbol * (entry.symbol.get(term) ?? 0)
        + BM25_FIELD_WEIGHTS.symbolType * (entry.symbolType.get(term) ?? 0)
        + BM25_FIELD_WEIGHTS.content * (entry.content.get(term) ?? 0)
      if (tf <= 0) continue
      let idf = Math.log((n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      if (idf <= 0) idf = 1e-6
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d) / avgdl))
    }
    if (score > 0) hits.push({ id: entry.id, score })
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return hits
}

/** raw/max 归一化并钳到 [0,1]（bm25.py:388-402 的 search 层语义）。 */
export function normalizeScores(hits: readonly BM25Hit[]): Array<{ id: string; score: number }> {
  if (hits.length === 0) return []
  const maxScore = Math.max(...hits.map(hit => hit.score))
  const denom = maxScore > 0 ? maxScore : 1
  return hits.map(hit => ({ id: hit.id, score: Math.max(0, Math.min(1, hit.score / denom)) }))
}
