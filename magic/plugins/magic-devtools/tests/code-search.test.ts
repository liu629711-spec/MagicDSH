import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bm25Rank, normalizeScores, docLength, BM25_K1, BM25_B } from '../src/code-search/bm25.ts'
import { chunkFile, chunkFixedLines, detectLanguage, snippetPreview } from '../src/code-search/chunker.ts'
import { getWorkspaceIndex, resetWorkspaceIndex, MAX_INDEX_FILES } from '../src/code-search/manager.ts'
import { grepKeywordSuggestions, renderSearch } from '../src/code-search/index.ts'
import { tokenizeQuery, tokenizeDoc, queryTerms } from '../src/code-search/tokenize.ts'

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'magic-codesearch-'))
}

// ── 词法（bm25.py:16-18, 432-457）──────────────────────────────────────────

test('tokenizeQuery：标识符保持完整、CJK 拆分并产 bigram', () => {
  assert.deepEqual(tokenizeQuery('foo_bar ApprovalGate'), ['foo_bar', 'ApprovalGate'])
  assert.deepEqual(tokenizeQuery('审批门控'), ['审批门控', '审批', '批门', '门控'])
  assert.deepEqual(tokenizeQuery('User model'), ['User', 'model'])
  assert.deepEqual(tokenizeQuery('render42'), ['render42'])
  assert.deepEqual(tokenizeQuery(''), [])
})

test('tokenizeDoc 与 queryTerms 小写归一', () => {
  assert.deepEqual(tokenizeDoc('function renderWidget() { return 42 }'), ['function', 'renderwidget', 'return', '42'])
  assert.deepEqual(queryTerms('Widget'), ['widget'])
})

// ── BM25 手算例（公式见 bm25.ts 头注释；k1=1.2, b=0.75）───────────────────

test('bm25Rank 手算：单命中文档 idf·tf(k1+1)/(tf+k1(1-b+b·D/avgdl))', () => {
  const docs = [
    { id: 'd1', symbol: [], symbolType: [], content: ['alpha', 'beta'] },
    { id: 'd2', symbol: [], symbolType: [], content: ['alpha', 'gamma'] },
    { id: 'd3', symbol: [], symbolType: [], content: ['delta', 'epsilon'] },
    { id: 'd4', symbol: [], symbolType: [], content: ['zeta', 'eta', 'theta'] },
  ]
  const hits = bm25Rank(docs, ['gamma'])
  assert.equal(hits.length, 1)
  // N=4, n(gamma)=1 → idf=ln(3.5/1.5)；tf_w=1，D=2，avgdl=9/4=2.25
  // 分母 = 1 + 1.2·(1−0.75+0.75·2/2.25) = 1 + 1.1 = 2.1（注意 tf 项在前）
  // score = idf · 1·2.2 / (1 + 1.2·(0.25+0.6667)) = idf·2.2/2.1
  const idf = Math.log(3.5 / 1.5)
  const expected = (idf * 1 * (BM25_K1 + 1)) / (1 + BM25_K1 * (1 - BM25_B + BM25_B * (2 / 2.25)))
  assert.ok(Math.abs(hits[0]!.score - expected) < 1e-12)
  // 直观核对：分母 1 + 1.2·0.91667 = 2.1
  assert.ok(Math.abs(expected - (idf * 2.2) / 2.1) < 1e-12)
})

test('bm25Rank：idf≤0 钳到 1e-6（FTS5 行为），同构文档得分相等', () => {
  const docs = [
    { id: 'a', symbol: [], symbolType: [], content: ['alpha', 'beta'] },
    { id: 'b', symbol: [], symbolType: [], content: ['alpha', 'gamma'] },
    { id: 'c', symbol: [], symbolType: [], content: ['delta', 'epsilon'] },
    { id: 'd', symbol: [], symbolType: [], content: ['zeta', 'eta', 'theta'] },
  ]
  const hits = bm25Rank(docs, ['alpha'])
  assert.equal(hits.length, 2)
  // n(alpha)=2, N=4 → idf=ln(2.5/2.5)=0 → 1e-6
  assert.ok(Math.abs(hits[0]!.score - hits[1]!.score) < 1e-15)
  assert.ok(hits[0]!.score > 0)
  assert.ok(hits[0]!.score < 1e-4)
})

test('bm25Rank：symbol 字段权重(10) 让命名命中压过正文命中', () => {
  const filler = { symbol: [], symbolType: [], content: ['unrelated', 'stuff'] }
  const docs = [
    { id: 'named', symbol: ['render'], symbolType: ['method'], content: ['body', 'only'] },
    { id: 'body', symbol: [], symbolType: [], content: ['render', 'here'] },
    { id: 'f1', ...filler },
    { id: 'f2', ...filler },
    { id: 'f3', ...filler },
  ]
  const hits = bm25Rank(docs, ['render'])
  assert.equal(hits.length, 2)
  assert.equal(hits[0]!.id, 'named')
  assert.ok(hits[0]!.score > hits[1]!.score)
  assert.deepEqual(hits.map(h => h.id).sort(), ['body', 'named'])
})

test('normalizeScores 按 max 归一化钳到 [0,1]', () => {
  const raw = [
    { id: 'x', score: 3 },
    { id: 'y', score: 1.5 },
  ]
  assert.deepEqual(normalizeScores(raw), [
    { id: 'x', score: 1 },
    { id: 'y', score: 0.5 },
  ])
  assert.equal(docLength({ id: 'd', symbol: ['a'], symbolType: ['b'], content: ['c', 'd'] }), 4)
})

// ── 符号抽取（chunker.py 语义 + web-tree-sitter WASM）──────────────────────

test('detectLanguage 按扩展名映射，未知为 unknown', () => {
  assert.equal(detectLanguage('src/a.py'), 'python')
  assert.equal(detectLanguage('src/b.ts'), 'typescript')
  assert.equal(detectLanguage('src/c.tsx'), 'tsx')
  assert.equal(detectLanguage('src/d.mts'), 'typescript')
  assert.equal(detectLanguage('src/e.js'), 'javascript')
  assert.equal(detectLanguage('src/f.mjs'), 'javascript')
  assert.equal(detectLanguage('src/g.rs'), 'unknown')
})

test('snippetPreview 只留前三行', () => {
  assert.equal(snippetPreview('a\nb'), 'a\nb')
  assert.equal(snippetPreview('a\nb\nc\nd'), 'a\nb\nc')
})

test('chunkFile（typescript WASM）：函数/类/方法/命名导出抽取', async () => {
  const source = [
    'export function alpha(a: number): number {',
    '  return a',
    '}',
    '',
    'class Widget {',
    '  render(): void {',
    '    return',
    '  }',
    '}',
    '',
    'function hidden() {',
    '  return alpha(1)',
    '}',
    '',
    'const arrow = () => {',
    '  return 2',
    '}',
  ].join('\n')
  const chunks = await chunkFile('src/sample.ts', source, 'typescript')
  assert.ok(chunks.length > 0, 'tree-sitter 应产出符号块')

  const bySymbol = new Map(chunks.map(chunk => [chunk.symbol ?? `<anon@${String(chunk.startLine)}>`, chunk]))
  const alpha = chunks.find(chunk => chunk.symbol === 'alpha')
  assert.ok(alpha !== undefined)
  assert.ok(alpha.symbolType === 'function')
  assert.ok(alpha.startLine === 1 && alpha.endLine === 3)

  const widget = bySymbol.get('Widget')
  assert.ok(widget !== undefined && widget.symbolType === 'class')
  assert.ok(widget.startLine === 5 && widget.endLine === 9)

  const render = chunks.find(chunk => chunk.symbol === 'render')
  assert.ok(render !== undefined && render.symbolType === 'method')
  assert.equal(render.startLine, 6)

  const hidden = chunks.find(chunk => chunk.symbol === 'hidden')
  assert.ok(hidden !== undefined && hidden.symbolType === 'function')
  assert.equal(hidden.startLine, 11)

  // 箭头函数有块但无名字（蓝本 _extract_symbol_name 找不到 identifier）。
  const arrow = chunks.find(chunk => chunk.startLine === 15)
  assert.ok(arrow !== undefined)
  assert.ok(arrow.symbol === null)
  assert.equal(arrow.language, 'typescript')

  // 每块内容确实是源码切片。
  assert.ok(alpha.content.includes('return a'))
})

test('chunkFile（python WASM）：function_definition / class_definition', async () => {
  const source = [
    'def alpha(x):',
    '    return x',
    '',
    'class Beta:',
    '    def render(self):',
    '        return 1',
  ].join('\n')
  const chunks = await chunkFile('src/sample.py', source, 'python')
  assert.equal(chunks.find(chunk => chunk.symbol === 'alpha')?.symbolType, 'function')
  assert.equal(chunks.find(chunk => chunk.symbol === 'Beta')?.symbolType, 'class')
  // 蓝本 _SYMBOL_TYPE：python 方法节点是 function_definition → 'function'
  //（'method' 只来自 TS/JS 的 method_definition）。
  assert.equal(chunks.find(chunk => chunk.symbol === 'render')?.symbolType, 'function')
})

test('chunkFixedLines：50 行一块的 fallback', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${String(i)}`)
  const chunks = chunkFixedLines('a.txt', lines.join('\n'), 'unknown')
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0]!.startLine, 1)
  assert.equal(chunks[0]!.endLine, 50)
  assert.equal(chunks[1]!.startLine, 51)
  assert.equal(chunks[2]!.endLine, 120)
  assert.equal(chunks[0]!.symbol, null)
})

// ── IndexManager 等价物：建索引 / 增量刷新 / 查询只读快照 ─────────────────

test('索引：首查命中、改文件后增量刷新命中变化', async () => {
  const ws = tempWorkspace()
  resetWorkspaceIndex(ws)
  const fileA = join(ws, 'alpha.ts')
  writeFileSync(fileA, 'export function helloAlpha(): string { return "greeting words" }\n')

  const index = getWorkspaceIndex(ws)
  await index.ensureAsync()
  assert.equal(index.status, 'READY')
  assert.equal(index.indexedFileCount, 1)

  const hits = index.search('helloAlpha')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0]!.chunk.symbol, 'helloAlpha')
  assert.equal(hits[0]!.chunk.path, 'alpha.ts')
  assert.ok(hits[0]!.score > 0.99) // 归一化后 top=1

  // 改内容（不同符号）：mtime/尺寸指纹变化 → 增量重建。
  writeFileSync(fileA, 'export function goodbyeAlpha(): string { return "farewell words" }\n')
  const future = new Date(Date.now() + 20_000)
  utimesSync(fileA, future, future)
  await index.ensureAsync()
  assert.equal(index.search('helloAlpha').length, 0)
  const after = index.search('goodbyeAlpha')
  assert.ok(after.length >= 1)
  assert.equal(after[0]!.chunk.symbol, 'goodbyeAlpha')

  // node_modules / .git 剪枝。
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(ws, 'node_modules', 'pkg', 'noise.ts'), 'export function noiseNode(): void {}\n')
  mkdirSync(join(ws, '.git'), { recursive: true })
  writeFileSync(join(ws, '.git', 'noise.ts'), 'export function noiseGit(): void {}\n')
  await index.ensureAsync()
  assert.equal(index.search('noiseNode').length, 0)
  assert.equal(index.search('noiseGit').length, 0)
  assert.equal(index.indexedFileCount, 1)

  // 删除文件 → 从索引移除。
  rmSync(fileA)
  await index.ensureAsync()
  assert.equal(index.indexedFileCount, 0)
  assert.equal(index.search('goodbyeAlpha').length, 0)

  resetWorkspaceIndex(ws)
  rmSync(ws, { recursive: true, force: true })
})

test('索引：path_prefix / language 过滤与查询只读（search 不触发构建）', async () => {
  const ws = tempWorkspace()
  resetWorkspaceIndex(ws)
  mkdirSync(join(ws, 'web'), { recursive: true })
  writeFileSync(join(ws, 'web', 'a.ts'), 'export function webLoader(): void {}\n')
  writeFileSync(join(ws, 'py_mod.py'), 'def web_loader():\n    pass\n')

  const index = getWorkspaceIndex(ws)
  await index.ensureAsync()

  const scoped = index.search('webLoader', { pathPrefix: 'web' })
  assert.ok(scoped.length >= 1)
  assert.ok(scoped.every(hit => hit.chunk.path.startsWith('web/')))

  const tsOnly = index.search('webLoader', { language: 'typescript' })
  assert.ok(tsOnly.length >= 1)
  assert.ok(tsOnly.every(hit => hit.chunk.language === 'typescript'))

  const pyOnly = index.search('web_loader', { language: 'python' })
  assert.ok(pyOnly.length >= 1)
  assert.ok(pyOnly.every(hit => hit.chunk.language === 'python'))

  // 空查询词 → 无结果
  assert.equal(index.search('   ', {}).length, 0)
  assert.deepEqual(index.search('zzz-no-match', { maxResults: 5 }), [])

  resetWorkspaceIndex(ws)
  rmSync(ws, { recursive: true, force: true })
})

test('limit 硬顶 50：超过 50 条命中也只返回 50', async () => {
  const ws = tempWorkspace()
  resetWorkspaceIndex(ws)
  // 60 个文件、每个都有同名符号（query token 与符号一致才可命中）。
  for (let i = 0; i < 60; i += 1) {
    writeFileSync(join(ws, `mod${String(i)}.ts`), 'export function needleFn(): void { return }\n')
  }
  const index = getWorkspaceIndex(ws)
  await index.ensureAsync()
  assert.equal(index.search('needleFn', { maxResults: 100 }).length, 50)
  assert.equal(index.search('needleFn', { maxResults: 5 }).length, 5)
  resetWorkspaceIndex(ws)
  rmSync(ws, { recursive: true, force: true })
})

// ── 渲染（code_search.py:154-255）─────────────────────────────────────────

test('renderSearch 输出 文件:行号 + symbol + score，空结果给 grep 建议', () => {
  const rendered = renderSearch(
    [
      {
        chunk: {
          path: 'src/a.ts',
          symbol: 'alpha',
          symbolType: 'function',
          startLine: 1,
          endLine: 3,
          language: 'typescript',
          content: 'export function alpha() {\n  return 1\n}',
        },
        score: 1,
      },
    ],
    { query: 'alpha', pathPrefix: '.', status: 'READY' },
  )
  assert.match(rendered, /src\/a\.ts:1-3  alpha \(function\) \(typescript\)/)
  assert.match(rendered, /score=1\.00/)
  assert.match(rendered, /共 1 条结果/)

  const empty = renderSearch([], { query: '审批门控', pathPrefix: 'src', status: 'READY' })
  assert.match(empty, /未命中任何代码块（path_prefix='src'）/)
  assert.match(empty, /建议用 grep 精确搜这些关键词：`审批门控`/)

  const stale = renderSearch([], { query: 'alpha', pathPrefix: '.', status: 'STALE' })
  assert.match(stale, /索引可能过旧或不完整/)
})

test('grepKeywordSuggestions 标识符优先（code_search.py:230-255）', () => {
  const out = grepKeywordSuggestions('审批 ApprovalGate foo_bar render 42')
  // snake/Camel 优先（同分按 token 长度降序），随后才是普通标识符与 CJK。
  assert.equal(out[0], 'ApprovalGate')
  assert.ok(out.includes('foo_bar'))
  assert.ok(out.indexOf('foo_bar') < out.indexOf('render'))
  assert.ok(out.length <= 5)
})

test('MAX_INDEX_FILES 蓝本值 5000', () => {
  assert.equal(MAX_INDEX_FILES, 5000)
})
