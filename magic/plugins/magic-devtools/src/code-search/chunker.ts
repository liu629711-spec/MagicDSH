/**
 * tree-sitter 符号级 chunking + 定长行 fallback —— 对齐 AgentCore
 * workspace/indexing/chunker.py（242 行）。
 *
 * 语言与符号节点（chunker.py:14-30）：python=function_definition/class_definition；
 * typescript/tsx=function_declaration/class_declaration/method_definition/
 * arrow_function/export_statement。Magic 增加 javascript（同为 TS 家族语法，
 * 语料取 tree-sitter-wasms 的 tree-sitter-javascript.wasm —— 任务规格要求 js）。
 *
 * 与蓝本的差异：tree-sitter 从原生绑定（tree_sitter_python 等）换成
 * web-tree-sitter + tree-sitter-wasms 的 .wasm 语料（任务规格钉死）；
 * node API 换名（start_byte→startIndex、hasError 同名）；其余遍历/
 * 去重/命名导出/行号/fallback 语义逐行对齐 chunker.py:132-242。
 */

import { createRequire } from 'node:module'
import { Parser, Language } from 'web-tree-sitter'
import { tokenizeDoc } from './tokenize.ts'

export const FALLBACK_LINES_PER_CHUNK = 50
export const SNIPPET_PREVIEW_LINES = 3

/** 各语言的符号节点类型（chunker.py:14-30）。 */
export const SYMBOL_NODE_TYPES: Record<string, readonly string[]> = {
  python: ['function_definition', 'class_definition'],
  typescript: [
    'function_declaration',
    'class_declaration',
    'method_definition',
    'arrow_function',
    'export_statement',
  ],
  tsx: [
    'function_declaration',
    'class_declaration',
    'method_definition',
    'arrow_function',
    'export_statement',
  ],
  javascript: [
    'function_declaration',
    'class_declaration',
    'method_definition',
    'arrow_function',
    'export_statement',
  ],
}

const SYMBOL_TYPE: Record<string, string> = {
  function_definition: 'function',
  function_declaration: 'function',
  arrow_function: 'function',
  class_definition: 'class',
  class_declaration: 'class',
  method_definition: 'method',
}

/** 扩展名 → 语言（chunker.py:41-48 + js 家族扩展）。 */
export const EXT_TO_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.pyi': 'python',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
}

/** 一个可索引代码块（chunker.py:54-64 RawChunk）。 */
export interface RawChunk {
  path: string
  symbol: string | null
  symbolType: string | null
  startLine: number
  endLine: number
  language: string
  content: string
}

/** 扩展名映射到 chunking 语言 id，认不出为 unknown（chunker.py:67-73）。 */
export function detectLanguage(path: string): string {
  const lower = path.toLowerCase()
  for (const [ext, lang] of Object.entries(EXT_TO_LANGUAGE)) {
    if (lower.endsWith(ext)) return lang
  }
  return 'unknown'
}

/** 结果预览前 3 行（chunker.py:76-81）。 */
export function snippetPreview(content: string, maxLines: number = SNIPPET_PREVIEW_LINES): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  return lines.slice(0, maxLines).join('\n')
}

// ── web-tree-sitter 加载（懒初始化单例）───────────────────────────────────

const require = createRequire(import.meta.url)

const WASM_FILES: Record<string, string> = {
  python: 'tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
}

let parserPromise: Promise<Parser | null> | undefined

async function ensureParser(): Promise<Parser | null> {
  if (parserPromise === undefined) {
    parserPromise = (async () => {
      try {
        await Parser.init()
        const parser = new Parser()
        const langs = new Map<string, Language>()
        for (const [lang, wasm] of Object.entries(WASM_FILES)) {
          langs.set(lang, await Language.load(require.resolve(`tree-sitter-wasms/out/${wasm}`)))
        }
        const setLanguage = parser.setLanguage.bind(parser)
        return Object.assign(parser, {
          use(lang: string): boolean {
            const l = langs.get(lang)
            if (l === undefined) return false
            setLanguage(l)
            return true
          },
        }) as Parser
      } catch {
        // 语料不可用 → 全部走定长行 fallback（对齐 chunker.py:93-104 的诚实降级）。
        parserPromise = Promise.resolve(null)
        return null
      }
    })()
  }
  return parserPromise
}

interface ParserWithLang extends Parser {
  use(lang: string): boolean
}

/** 按符号边界切分；解析失败/无符号时定长行 fallback（chunker.py:84-90）。 */
export async function chunkFile(path: string, content: string, language: string): Promise<RawChunk[]> {
  if (language in SYMBOL_NODE_TYPES) {
    const parser = (await ensureParser()) as ParserWithLang | null
    if (parser !== null && parser.use(language)) {
      const chunks = chunkWithTreeSitter(parser, path, content, language)
      if (chunks.length > 0) return chunks
    }
  }
  return chunkFixedLines(path, content, language)
}

function chunkWithTreeSitter(
  parser: ParserWithLang,
  path: string,
  content: string,
  language: string,
): RawChunk[] {
  let root
  try {
    root = parser.parse(content)?.rootNode ?? null
  } catch {
    return []
  }
  if (root === null || root.hasError) return []

  const symbolTypes = SYMBOL_NODE_TYPES[language] ?? []
  const chunks: RawChunk[] = []
  const seenSpans = new Set<string>()

  function extractSymbolName(node: any): string | null {
    for (const child of node.children) {
      // type_identifier：TS 的 class_declaration 名字节点。蓝本 _extract_symbol_name
      // （chunker.py:198-206）漏了这个类型导致 TS 类名全为 null——此处为有据扩展，
      // 其余与蓝本一致。
      if (
        child.type === 'identifier'
        || child.type === 'name'
        || child.type === 'property_identifier'
        || child.type === 'type_identifier'
      ) {
        return content.slice(child.startIndex, child.endIndex)
      }
      if (child.type === 'function') {
        for (const sub of child.children) {
          if (sub.type === 'identifier') return content.slice(sub.startIndex, sub.endIndex)
        }
      }
    }
    return null
  }

  function exportInnerSymbol(node: any): any {
    for (const child of node.children) {
      if (
        (SYMBOL_NODE_TYPES[language] ?? []).includes(child.type)
        || child.type === 'function_declaration'
        || child.type === 'class_declaration'
        || child.type === 'lexical_declaration'
      ) {
        return child
      }
    }
    return null
  }

  function symbolTypeFor(node: any): string | null {
    if (node.type === 'export_statement') {
      const inner = exportInnerSymbol(node)
      if (inner !== null) return SYMBOL_TYPE[inner.type] ?? null
      return null
    }
    return SYMBOL_TYPE[node.type] ?? null
  }

  function visit(node: any): void {
    if (symbolTypes.includes(node.type)) {
      const spanKey = `${node.startIndex}:${node.endIndex}`
      if (!seenSpans.has(spanKey)) {
        seenSpans.add(spanKey)
        let symbol = extractSymbolName(node)
        let symType = symbolTypeFor(node)
        if (node.type === 'export_statement') {
          const inner = exportInnerSymbol(node)
          if (inner !== null) {
            symbol = extractSymbolName(inner) ?? symbol
            symType = symbolTypeFor(inner) ?? symType
          }
        }
        // 对齐 chunker.py:165-167：行号/内容始终取外层节点字节范围。
        const startLine = content.slice(0, node.startIndex).split('\n').length
        const endLine = content.slice(0, node.endIndex).split('\n').length
        const chunkContent = content.slice(node.startIndex, node.endIndex)
        if (chunkContent.trim() !== '') {
          chunks.push({
            path,
            symbol,
            symbolType: symType,
            startLine,
            endLine,
            language,
            content: chunkContent,
          })
        }
      }
    }
    for (const child of node.children) visit(child)
  }

  visit(root)
  return chunks
}

/** 定长行 fallback：50 行一块（chunker.py:222-242）。 */
export function chunkFixedLines(path: string, content: string, language: string): RawChunk[] {
  const lines = content.split('\n')
  if (lines.length === 0 || content === '') return []
  const chunks: RawChunk[] = []
  for (let startIdx = 0; startIdx < lines.length; startIdx += FALLBACK_LINES_PER_CHUNK) {
    const endIdx = Math.min(startIdx + FALLBACK_LINES_PER_CHUNK, lines.length)
    const chunkContent = lines.slice(startIdx, endIdx).join('\n')
    chunks.push({
      path,
      symbol: null,
      symbolType: null,
      startLine: startIdx + 1,
      endLine: endIdx,
      language,
      content: chunkContent,
    })
  }
  return chunks
}

/** 预分词投影（BM25 打分输入）：symbol/symbolType/content 三字段。 */
export function chunkToDocTokens(chunk: RawChunk): {
  symbol: string[]
  symbolType: string[]
  content: string[]
} {
  return {
    symbol: chunk.symbol === null ? [] : tokenizeDoc(chunk.symbol),
    symbolType: chunk.symbolType === null ? [] : tokenizeDoc(chunk.symbolType),
    content: tokenizeDoc(chunk.content),
  }
}
