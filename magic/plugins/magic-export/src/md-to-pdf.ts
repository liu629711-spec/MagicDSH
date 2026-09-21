/**
 * Markdown → PDF 确定性转换器。
 *
 * 行为蓝本：AgentCore docs_export/md_to_pdf.py（markdown-it-py + fpdf2）。蓝本选 fpdf2
 * 的理由（纯实现、无 Chromium/HTML 引擎）在本插件对应为 pdf-lib + 标准字体排版：
 * A4 页面、18mm 页边距、标题/正文/代码字号区分、自动换行与分页。
 *
 * 覆盖范围与蓝本一致：标题 #–####（一级居中）、段落、有序/无序列表、表格、围栏代码、
 * 引用、分隔线；图片一律渲染为 alt 占位 + 明确警告（PDF 不嵌图，蓝本同口径）。
 *
 * 字体偏离说明：pdf-lib 标准字体只覆盖 WinAnsi，内嵌 CJK 字体需要 @pdf-lib/fontkit
 * （不在本插件允许依赖内）。因此无 CJK 字形可用，行为对齐蓝本「缺 CJK 字体」分支：
 * 回执附明确警告（绝不静默豆腐块），非可编码字符替换为 '?' 以免转换崩溃。
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { LAYOUT_OFFICIAL, LAYOUT_STANDARD, type DocLayout } from './layout.ts'
import { isCjkChar, inlineText, inlineTextWithImages, parseMarkdown, type Token } from './markdown.ts'
import type { Tokens } from 'marked'

/** 标题深度：writeHeading 的入参只接受 clamp 后的 1..4，正是 HEADING_PT 的键集。 */
type HeadingDepth = 1 | 2 | 3 | 4

const HEADING_PT: Record<HeadingDepth, number> = { 1: 20, 2: 16, 3: 14, 4: 12 }
const BODY_PT = 11
const CODE_PT = 9
const TABLE_PT = 10
const LABEL_PT = 8

const A4_WIDTH = 595.276
const A4_HEIGHT = 841.89
const mm = (v: number): number => (v * 72) / 25.4
const MARGIN = mm(18) // 蓝本 fpdf：set_margins(18, 18, 18) + auto page break margin 18
const LINE = mm(6) // 蓝本 _LINE = 6.0mm
const CODE_LINE = mm(5.5) // 蓝本代码/表格行高 _LINE - 0.5mm

/** 蓝本缺 CJK 字体时的警告口径（按本插件实际约束改述，仍是「绝不静默」）。 */
export const CJK_FONT_WARNING =
  '未找到可用的 CJK 字体（PDF 标准字体仅支持 WinAnsi，未内嵌 CJK 字体）。'
  + '中文可能显示为方框；请安装 Noto Sans CJK 或在支持 CJK 内嵌的导出器中重试。'

export interface MdToPdfResult {
  pdfBytes: Uint8Array
  warnings: string[]
}

export interface ConvertPdfOptions {
  layout?: DocLayout
}

interface PdfState {
  doc: PDFDocument
  page: PDFPage
  y: number // 光标距页顶的 pt 数（对齐 fpdf 的 get_y 语义）
  readonly pageW: number
  readonly pageH: number
  readonly margin: number
  readonly bottom: number // 自动换页阈值：pageH - 18mm
  readonly usable: number
}

type Warn = (msg: string) => void

interface FontBundle {
  regular: PDFFont
  bold: PDFFont
}

function ensureSpace(state: PdfState, height: number): void {
  if (state.y + height > state.bottom) {
    state.page = state.doc.addPage([A4_WIDTH, A4_HEIGHT])
    state.y = state.margin
  }
}

/** 画一行文本：基线取「行顶 + 1em」的近似；空行只推进光标。 */
function drawLine(
  state: PdfState,
  text: string,
  opts: { size: number; font: PDFFont; color?: ReturnType<typeof rgb>; align?: 'center' | 'left'; x?: number },
): void {
  if (text !== '') {
    const width = opts.font.widthOfTextAtSize(text, opts.size)
    let x = opts.x ?? state.margin
    if (opts.align === 'center') x = state.margin + (state.usable - width) / 2
    state.page.drawText(text, {
      x,
      y: state.pageH - state.y - opts.size,
      size: opts.size,
      font: opts.font,
      color: opts.color ?? rgb(0, 0, 0),
    })
  }
}

/** 按可用宽度贪心换行：西文按词、CJK 按字，超长单词硬切（fpdf multi_cell 同效）。 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const unit of splitUnits(rawLine)) {
      const candidate = line + unit
      if (line !== '' && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        out.push(line.replace(/\s+$/, ''))
        line = unit === ' ' ? '' : unit
      } else {
        line = candidate
      }
      while (line.length > 1 && font.widthOfTextAtSize(line, size) > maxWidth) {
        let cut = line.length
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut -= 1
        out.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    if (line !== '') out.push(line.replace(/\s+$/, ''))
  }
  return out
}

/** 切分换行单元：空格为独立分隔单元，CJK 字逐字，其余连续西文成词。 */
function splitUnits(text: string): string[] {
  const units: string[] = []
  let current = ''
  for (const ch of text) {
    if (ch === ' ') {
      if (current !== '') {
        units.push(current)
        current = ''
      }
      units.push(' ')
      continue
    }
    if (isCjkChar(ch)) {
      if (current !== '') {
        units.push(current)
        current = ''
      }
      units.push(ch)
      continue
    }
    current += ch
  }
  if (current !== '') units.push(current)
  return units
}

/** 标准字体不可编码的字符替换为 '?'（调用方已先附上缺字体警告，绝不静默）。 */
function sanitizeText(text: string, font: PDFFont): string {
  if (text === '') return text
  try {
    font.encodeText(text)
    return text
  } catch {
    let out = ''
    for (const ch of text) {
      try {
        font.encodeText(ch)
        out += ch
      } catch {
        out += '?'
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// 块级渲染
// ---------------------------------------------------------------------------

function writeHeading(state: PdfState, fonts: FontBundle, text: string, level: HeadingDepth): void {
  const size = HEADING_PT[level]
  const gap = mm(level <= 2 ? 3 : 2)
  const lh = mm(7) // 蓝本 multi_cell(0, _LINE + 1)
  const lines = wrapText(sanitizeText(text, fonts.bold), fonts.bold, size, state.usable)
  ensureSpace(state, gap + lh)
  state.y += gap
  const safeLines = lines.length > 0 ? lines : ['']
  for (const line of safeLines) {
    ensureSpace(state, lh)
    // 文档大标题居中是通例（同 md_to_docx），两个档位都开。
    drawLine(state, line, { size, font: fonts.bold, align: level === 1 ? 'center' : 'left' })
    state.y += lh
  }
  state.y += mm(1)
}

function writeParagraph(
  state: PdfState,
  fonts: FontBundle,
  text: string,
  firstLineIndent: boolean,
): void {
  if (text.trim() === '') {
    state.y += mm(2)
    return
  }
  const lines = wrapText(sanitizeText(text, fonts.regular), fonts.regular, BODY_PT, state.usable)
  const indent = firstLineIndent ? 2 * BODY_PT : 0 // 首行缩进 2em（蓝本：FIRST_LINE_INDENT_CHARS * font_size）
  for (const [i, line] of lines.entries()) {
    ensureSpace(state, LINE)
    drawLine(state, line, {
      size: BODY_PT,
      font: fonts.regular,
      x: state.margin + (i === 0 ? indent : 0),
    })
    state.y += LINE
  }
  state.y += mm(1)
}

function writeCode(state: PdfState, fonts: FontBundle, content: string, info: string): void {
  const text = content.endsWith('\n') ? content.slice(0, -1) : content
  if (info !== '') {
    ensureSpace(state, mm(4))
    drawLine(state, sanitizeText(info, fonts.regular), {
      size: LABEL_PT,
      font: fonts.regular,
      color: rgb(100 / 255, 100 / 255, 100 / 255),
    })
    state.y += mm(4)
  }
  const lh = CODE_LINE
  for (const rawLine of text.split('\n')) {
    const wrapped = wrapText(sanitizeText(rawLine, fonts.regular), fonts.regular, CODE_PT, state.usable - mm(3))
    for (const line of wrapped) {
      ensureSpace(state, lh)
      state.page.drawRectangle({
        x: state.margin,
        y: state.pageH - state.y - lh,
        width: state.usable,
        height: lh,
        color: rgb(244 / 255, 244 / 255, 245 / 255),
      })
      drawLine(state, line, { size: CODE_PT, font: fonts.regular, x: state.margin + mm(1.5) })
      state.y += lh
    }
  }
  state.y += mm(2)
}

function writeHr(state: PdfState): void {
  state.y += mm(2)
  ensureSpace(state, mm(1))
  const y = state.pageH - state.y
  state.page.drawLine({
    start: { x: state.margin, y },
    end: { x: state.pageW - state.margin, y },
    thickness: 0.5,
    color: rgb(180 / 255, 180 / 255, 180 / 255),
  })
  state.y += mm(4)
}

function writeBlockquote(state: PdfState, fonts: FontBundle, text: string): void {
  const gray = rgb(80 / 255, 80 / 255, 80 / 255)
  const lines = wrapText(sanitizeText(`| ${text}`, fonts.regular), fonts.regular, BODY_PT, state.usable)
  for (const line of lines) {
    ensureSpace(state, LINE)
    drawLine(state, line, { size: BODY_PT, font: fonts.regular, color: gray })
    state.y += LINE
  }
}

function writeListItem(
  state: PdfState,
  fonts: FontBundle,
  text: string,
  ordered: boolean,
  index: number,
  level: number,
): void {
  const bullet = ordered ? `${String(index)}. ` : '- '
  const indent = '  '.repeat(level)
  const lines = wrapText(sanitizeText(`${indent}${bullet}${text}`, fonts.regular), fonts.regular, BODY_PT, state.usable)
  for (const line of lines) {
    ensureSpace(state, LINE)
    drawLine(state, line, { size: BODY_PT, font: fonts.regular })
    state.y += LINE
  }
}

function writeTable(state: PdfState, fonts: FontBundle, rows: string[][]): void {
  if (rows.length === 0) return
  const cols = Math.max(...rows.map((r) => r.length), 1)
  const colW = state.usable / cols
  const gray = rgb(200 / 255, 200 / 255, 200 / 255)
  const headerFill = rgb(245 / 255, 245 / 255, 246 / 255)
  for (const [r, row] of rows.entries()) {
    const isHeader = r === 0
    const font = isHeader ? fonts.bold : fonts.regular
    const cellLines = Array.from({ length: cols }, (_, c) => {
      const cell = row[c] ?? ''
      return wrapText(sanitizeText(cell === '' ? ' ' : cell, font), font, TABLE_PT, colW - mm(2))
    })
    const maxLines = Math.max(...cellLines.map((l) => l.length), 1)
    const rowH = maxLines * CODE_LINE + mm(2)
    ensureSpace(state, rowH + mm(2))
    for (const [c, lines] of cellLines.entries()) {
      const x = state.margin + c * colW
      const rectTop = state.pageH - state.y - rowH
      if (isHeader) {
        state.page.drawRectangle({
          x,
          y: rectTop,
          width: colW,
          height: rowH,
          color: headerFill,
          borderColor: gray,
          borderWidth: 0.5,
        })
      } else {
        state.page.drawRectangle({ x, y: rectTop, width: colW, height: rowH, borderColor: gray, borderWidth: 0.5 })
      }
      for (const line of lines) {
        if (line === '') continue
        state.page.drawText(line, {
          x: x + mm(1),
          y: state.pageH - state.y - TABLE_PT,
          size: TABLE_PT,
          font,
        })
      }
    }
    state.y += rowH
  }
  state.y += mm(2)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function convertMarkdownToPdf(
  markdown: string,
  options: ConvertPdfOptions = {},
): Promise<MdToPdfResult> {
  const warnings: string[] = [CJK_FONT_WARNING]
  const warn: Warn = (msg) => {
    if (!warnings.includes(msg)) warnings.push(msg)
  }
  const indentBody = (options.layout ?? LAYOUT_STANDARD) === LAYOUT_OFFICIAL
  // 蓝本缺 CJK 字体 → 明确警告 + Helvetica 兜底；本插件固定走该分支（见文件头偏离说明）。

  const doc = await PDFDocument.create()
  const fonts: FontBundle = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  }
  const state: PdfState = {
    doc,
    page: doc.addPage([A4_WIDTH, A4_HEIGHT]),
    y: MARGIN,
    pageW: A4_WIDTH,
    pageH: A4_HEIGHT,
    margin: MARGIN,
    bottom: A4_HEIGHT - MARGIN,
    usable: A4_WIDTH - 2 * MARGIN,
  }

  renderBlocks(state, fonts, parseMarkdown(markdown), { indentBody, level: 0 }, warn)

  const pdfBytes = await doc.save()
  return { pdfBytes: new Uint8Array(pdfBytes), warnings }
}

interface BlockRenderCtx {
  indentBody: boolean
  level: number
}

function renderBlocks(
  state: PdfState,
  fonts: FontBundle,
  tokens: Token[],
  blockCtx: BlockRenderCtx,
  warn: Warn,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading
        // 夹到 1..4 = HEADING_PT 的键集（marked 的 depth 恒为 1..6 整数），故 writeHeading 收字面量联合。
        const level = Math.max(1, Math.min(Number(heading.depth) || 1, 4)) as HeadingDepth
        writeHeading(state, fonts, inlineText(heading.tokens ?? []), level)
        break
      }
      case 'paragraph': {
        const { text, warnings } = inlineTextWithImages((token as Tokens.Paragraph).tokens ?? [])
        for (const w of warnings) warn(w)
        writeParagraph(state, fonts, text, blockCtx.indentBody)
        break
      }
      case 'text': {
        const { text, warnings } = inlineTextWithImages(inlineChildrenCompat(token))
        for (const w of warnings) warn(w)
        writeParagraph(state, fonts, text, false)
        break
      }
      case 'list':
        renderList(state, fonts, token as Tokens.List, blockCtx, warn)
        break
      case 'code':
        writeCode(state, fonts, (token as Tokens.Code).text ?? '', ((token as Tokens.Code).lang ?? '').trim())
        break
      case 'table': {
        const table = token as Tokens.Table
        const rows: string[][] = []
        rows.push([...(table.header ?? []).map((cell) => inlineText(cell.tokens ?? []))])
        for (const row of table.rows ?? []) {
          const cells = row.map((cell) => {
            const { text, warnings } = inlineTextWithImages(cell.tokens ?? [])
            for (const w of warnings) warn(w)
            return text
          })
          rows.push(cells)
        }
        writeTable(state, fonts, rows)
        break
      }
      case 'hr':
        writeHr(state)
        break
      case 'blockquote': {
        const quote = token as Tokens.Blockquote
        for (const child of quote.tokens ?? []) {
          if (child.type === 'paragraph') {
            const { text, warnings } = inlineTextWithImages((child as Tokens.Paragraph).tokens ?? [])
            for (const w of warnings) warn(w)
            writeBlockquote(state, fonts, text)
          } else if (child.type === 'list') {
            renderList(state, fonts, child as Tokens.List, blockCtx, warn)
          }
        }
        break
      }
      default:
        break
    }
  }
}

function renderList(
  state: PdfState,
  fonts: FontBundle,
  token: Tokens.List,
  blockCtx: BlockRenderCtx,
  warn: Warn,
): void {
  let index = 0
  for (const item of token.items) {
    index += 1
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        renderList(state, fonts, child as Tokens.List, { ...blockCtx, level: blockCtx.level + 1 }, warn)
        continue
      }
      if (child.type === 'paragraph' || child.type === 'text') {
        const { text, warnings } = inlineTextWithImages(inlineChildrenCompat(child))
        for (const w of warnings) warn(w)
        writeListItem(state, fonts, text, token.ordered, index, blockCtx.level)
      }
    }
  }
}

function inlineChildrenCompat(token: Token): Token[] {
  const withChildren = token as unknown as { tokens?: Token[] }
  return Array.isArray(withChildren.tokens) ? withChildren.tokens : []
}
