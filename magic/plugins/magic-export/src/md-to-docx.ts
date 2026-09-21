/**
 * Markdown → DOCX 确定性转换器。
 *
 * 行为蓝本：AgentCore docs_export/md_to_docx.py（markdown-it-py + python-docx）；
 * 本插件以 marked 解析、docx(npm) 生成。覆盖范围与蓝本一致：标题 #–####、段落、
 * 有序/无序列表、表格、围栏代码、相对路径图片（嵌入）、链接；缺图有明确警告（绝不静默）。
 * 默认样式对齐蓝本「干净公文风」：黑体标题 / 宋体正文 / Times New Roman 西文 / Consolas 代码。
 *
 * 段落几何按 layout 档位走（见 layout.ts）：一级标题两档都居中；首行缩进两字只在
 * official 档开——档位来自调用方入参，绝不看正文内容猜。
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  NumberFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
} from 'docx'
import {
  FIRST_LINE_INDENT_CHARS,
  LAYOUT_OFFICIAL,
  LAYOUT_STANDARD,
  type DocLayout,
} from './layout.ts'
import { sniffImage } from './image-size.ts'
import {
  inlineChildrenOf,
  isEmbeddableRelativeSrc,
  parseMarkdown,
  type Token,
} from './markdown.ts'
import type { Tokens } from 'marked'

// 干净公文 defaults —— 缺字体时 Word 自行替换（蓝本 _FONT_*）。
const FONT_LATIN = 'Times New Roman'
const FONT_BODY_CJK = '宋体'
const FONT_HEADING_CJK = '黑体'
const FONT_CODE = 'Consolas'

/** 标题深度：marked 的 depth 经 renderHeading 夹取后只会落在这四个值上，两张表据此做全函数索引。 */
type HeadingDepth = 1 | 2 | 3 | 4

const HEADING_PT: Record<HeadingDepth, number> = { 1: 22, 2: 18, 3: 16, 4: 14 }
const BODY_PT = 12
const CODE_PT = 10
const LABEL_PT = 9
const MAX_IMAGE_WIDTH_IN = 5.8
const INLINE_IMAGE_WIDTH_IN = 3.2

// 单位换算：docx(npm) 用 half-point 字号、twip 间距/缩进；in→px 按 96dpi。
const hp = (pt: number): number => Math.round(pt * 2)
const cmToTwip = (cm: number): number => Math.round(cm * 566.9291338582677)
const inToPx = (inches: number): number => Math.round(inches * 96)

const HEADING_LEVELS: Record<HeadingDepth, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
}

const GRID_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
}

export interface MdToDocxResult {
  docxBytes: Uint8Array
  warnings: string[]
}

export interface ConvertDocxOptions {
  /** src → 图片字节；null 表示查找过但缺失（渲染 [缺图：…] 并警告）。 */
  images?: Record<string, Uint8Array | null>
  layout?: DocLayout
}

interface InlineCtx {
  images: Record<string, Uint8Array | null>
  warnings: string[]
  inHeading?: boolean
  headingPt?: number
  bold?: number
  italic?: number
  linkUrl?: string
}

interface BlockCtx {
  images: Record<string, Uint8Array | null>
  warnings: string[]
  indentBody: boolean
  orderedIndex: { value: number }
  level: number
}

function warn(warnings: string[], msg: string): void {
  if (!warnings.includes(msg)) warnings.push(msg)
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
  } catch {
    return false
  }
}

/** 有序列表数量（每个列表一个独立 numbering 引用，序号从 1 重启）。 */
function countOrderedLists(tokens: Token[]): number {
  let count = 0
  for (const token of tokens) {
    if (token.type === 'list') {
      const list = token as Tokens.List
      if (list.ordered) count += 1
      for (const item of list.items) count += countOrderedLists(item.tokens ?? [])
    } else if (token.type === 'blockquote') {
      count += countOrderedLists((token as Tokens.Blockquote).tokens ?? [])
    }
  }
  return count
}

export async function convertMarkdownToDocx(
  markdown: string,
  options: ConvertDocxOptions = {},
): Promise<MdToDocxResult> {
  const images: Record<string, Uint8Array | null> = { ...(options.images ?? {}) }
  const warnings: string[] = []
  const indentBody = (options.layout ?? LAYOUT_STANDARD) === LAYOUT_OFFICIAL
  const tokens = parseMarkdown(markdown)

  const orderedCount = countOrderedLists(tokens)
  const numberingConfig = Array.from({ length: orderedCount }, (_, i) => ({
    reference: `magic-export-ordered-${String(i)}`,
    levels: [0, 1, 2].map((level) => ({
      level,
      format: NumberFormat.DECIMAL,
      text: '%1.',
      alignment: AlignmentType.START,
      style: {
        paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
      },
    })),
  }))

  const blockCtx: BlockCtx = {
    images,
    warnings,
    indentBody,
    orderedIndex: { value: 0 },
    level: 0,
  }
  const children = renderBlocks(tokens, blockCtx)

  // 防御性兜底（蓝本 convert_markdown_to_docx 收尾）：声明缺失但没以 token 出现的图也警告。
  for (const [src, data] of Object.entries(images)) {
    if (data === null) warn(warnings, `缺图：${src}`)
  }

  const doc = new Document({
    numbering: { config: numberingConfig },
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: FONT_LATIN, hAnsi: FONT_LATIN, eastAsia: FONT_BODY_CJK },
            size: hp(BODY_PT),
          },
        },
      },
    },
    sections: [{
      // 蓝本 _apply_document_defaults：上下 2.54cm，左右 3.17cm。
      properties: {
        page: {
          margin: {
            top: cmToTwip(2.54),
            bottom: cmToTwip(2.54),
            left: cmToTwip(3.17),
            right: cmToTwip(3.17),
          },
        },
      },
      children,
    }],
  })

  const buffer = await Packer.toBuffer(doc)
  return { docxBytes: new Uint8Array(buffer), warnings }
}

// ---------------------------------------------------------------------------
// 块级渲染
// ---------------------------------------------------------------------------

function renderBlocks(tokens: Token[], blockCtx: BlockCtx): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        out.push(renderHeading(token as Tokens.Heading, blockCtx))
        break
      case 'paragraph':
        renderParagraphOrImage(out, token as Tokens.Paragraph, blockCtx)
        break
      case 'text':
        // 顶层裸文本块（marked 对无空行文本的处理）；按正文段渲染。
        out.push(bodyParagraph(inlineChildrenOf(token), blockCtx, {}))
        break
      case 'list':
        renderList(out, token as Tokens.List, blockCtx)
        break
      case 'code':
        renderFence(out, token as Tokens.Code)
        break
      case 'table':
        renderTable(out, token as Tokens.Table, blockCtx)
        break
      case 'hr':
        out.push(new Paragraph({ children: [new TextRun('─'.repeat(24))] }))
        break
      case 'blockquote': {
        const quote = token as Tokens.Blockquote
        for (const child of quote.tokens ?? []) {
          if (child.type === 'paragraph') {
            // 引用块不吃 official 档的首行缩进：整块左缩进 + 竖线已把它和正文分开。
            out.push(new Paragraph({
              indent: { left: cmToTwip(0.75) },
              spacing: { after: hp(6), line: 276 },
              children: [
                new TextRun({
                  text: '｜ ',
                  font: { ascii: FONT_LATIN, hAnsi: FONT_LATIN, eastAsia: FONT_BODY_CJK },
                  size: hp(BODY_PT),
                  color: '9CA3AF',
                }),
                ...renderInlineChildren(inlineChildrenOf(child), blockCtx),
              ],
            }))
          } else {
            // 蓝本只渲染引用内的段落；这里保留其余块级内容（列表/嵌套引用）避免静默丢正文。
            out.push(...renderBlocks([child], { ...blockCtx, level: blockCtx.level }))
          }
        }
        break
      }
      default:
        break
    }
  }
  return out
}

function renderHeading(token: Tokens.Heading, blockCtx: BlockCtx): Paragraph {
  // 夹到 1..4 正是两张标题表的键集（marked 的 depth 恒为 1..6 整数），断言成 HeadingDepth 让索引保持全函数。
  const level = Math.max(1, Math.min(Number(token.depth) || 1, 4)) as HeadingDepth
  const runs = renderInlineChildren(inlineChildrenOf(token), {
    ...blockCtx,
    inHeading: true,
    headingPt: HEADING_PT[level],
  })
  return new Paragraph({
    heading: HEADING_LEVELS[level],
    // 文档大标题居中是 Word 通例（公文与技术报告都成立），故两档默认都开。
    ...(level === 1 ? { alignment: AlignmentType.CENTER } : {}),
    spacing: { before: level <= 2 ? hp(12) : hp(8), after: hp(6) },
    children: runs,
  })
}

function renderParagraphOrImage(
  out: (Paragraph | Table)[],
  token: Tokens.Paragraph,
  blockCtx: BlockCtx,
): void {
  const children = inlineChildrenOf(token)
  const only = children[0]
  // 孤图片段落 → 独立图片块（比行内嵌在段里干净，蓝本同口径）。
  if (children.length === 1 && only?.type === 'image') {
    out.push(...imageBlock(only as Tokens.Image, blockCtx))
    return
  }
  out.push(bodyParagraph(children, blockCtx, {}))
}

function bodyParagraph(
  inlineChildren: Token[],
  blockCtx: BlockCtx,
  extra: Partial<IParagraphOptions>,
): Paragraph {
  return new Paragraph({
    spacing: { after: hp(6), line: 276 },
    ...(blockCtx.indentBody
      ? {
          indent: {
            firstLine: hp(BODY_PT * FIRST_LINE_INDENT_CHARS),
            // Word 的「缩进 2 字符」真身是 firstLineChars（随字号走）；docx(npm) 原生支持。
            firstLineChars: FIRST_LINE_INDENT_CHARS * 100,
          },
        }
      : {}),
    ...extra,
    children: renderInlineChildren(inlineChildren, blockCtx),
  })
}

function renderList(out: (Paragraph | Table)[], token: Tokens.List, blockCtx: BlockCtx): void {
  const reference = token.ordered ? `magic-export-ordered-${String(blockCtx.orderedIndex.value++)}` : undefined
  for (const item of token.items) {
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        renderList(out, child as Tokens.List, { ...blockCtx, level: blockCtx.level + 1 })
        continue
      }
      if (child.type === 'paragraph' || child.type === 'text') {
        out.push(new Paragraph({
          ...(reference !== undefined
            ? { numbering: { reference, level: Math.min(blockCtx.level, 2) } }
            : { bullet: { level: Math.min(blockCtx.level, 8) } }),
          // 蓝本：嵌套层级额外左缩进 0.75cm * level。
          ...(blockCtx.level > 0 ? { indent: { left: cmToTwip(0.75) * blockCtx.level } } : {}),
          spacing: { after: hp(6), line: 276 },
          children: renderInlineChildren(inlineChildrenOf(child), blockCtx),
        }))
      }
      // 其余子块（引用等）与蓝本一致：跳过。
    }
  }
}

function renderFence(out: (Paragraph | Table)[], token: Tokens.Code): void {
  const text = (token.text ?? '').replace(/\n$/, '')
  const lang = (token.lang ?? '').trim()
  if (lang !== '') {
    out.push(new Paragraph({
      spacing: { after: 0 },
      children: [new TextRun({
        text: lang,
        font: { ascii: FONT_CODE, hAnsi: FONT_CODE, eastAsia: FONT_BODY_CJK },
        size: hp(LABEL_PT),
        color: '6B7280',
      })],
    }))
  }
  out.push(new Paragraph({
    spacing: { after: hp(8) },
    shading: { type: ShadingType.CLEAR, fill: 'F4F4F5' },
    children: [new TextRun({
      text,
      font: { ascii: FONT_CODE, hAnsi: FONT_CODE, eastAsia: FONT_BODY_CJK },
      size: hp(CODE_PT),
    })],
  }))
}

function renderTable(out: (Paragraph | Table)[], token: Tokens.Table, blockCtx: BlockCtx): void {
  const header = token.header ?? []
  const rows = token.rows ?? []
  if (header.length === 0 && rows.length === 0) return
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1)
  // A4 可用宽度（11906 twip）减去左右 3.17cm 页边距。
  const usable = 11906 - cmToTwip(3.17) * 2
  const colW = Math.floor(usable / cols)

  const makeCell = (cell: Tokens.TableCell | undefined, headerBold: boolean): TableCell =>
    new TableCell({
      width: { size: colW, type: WidthType.DXA },
      children: [new Paragraph({
        children: renderInlineChildren(cell?.tokens ?? [], { ...blockCtx, boldExtra: headerBold }),
      })],
    })

  out.push(new Table({
    width: { size: usable, type: WidthType.DXA },
    columnWidths: Array.from({ length: cols }, () => colW),
    borders: GRID_BORDERS,
    rows: [
      new TableRow({ children: Array.from({ length: cols }, (_, i) => makeCell(header[i], true)) }),
      ...rows.map((row) => new TableRow({
        children: Array.from({ length: cols }, (_, i) => makeCell(row[i], false)),
      })),
    ],
  }))
  out.push(new Paragraph({}))
}

// ---------------------------------------------------------------------------
// 图片渲染（块级 + 行内共用；警告口径对齐蓝本 _render_image_block）
// ---------------------------------------------------------------------------

interface ImageRender {
  runs: (TextRun | ImageRun)[]
  /** 嵌入成功且有 alt 时给出居中图注段落。 */
  caption?: string
}

interface ImageWarnCtx {
  images: Record<string, Uint8Array | null>
  warnings: string[]
}

function renderImage(
  token: Tokens.Image,
  blockCtx: ImageWarnCtx,
  widthPx: number,
): ImageRender {
  const src = String(token.href ?? '').trim()
  const alt = (token.text ?? '').trim()
  const bodyFont = { ascii: FONT_LATIN, hAnsi: FONT_LATIN, eastAsia: FONT_BODY_CJK }
  const data = src in blockCtx.images ? blockCtx.images[src] : undefined

  if (src in blockCtx.images && data === null) {
    warn(blockCtx.warnings, `缺图：${src}`)
    return { runs: [new TextRun({ text: `[缺图：${alt || src}]`, font: bodyFont, size: hp(BODY_PT), color: 'B91C1C' })] }
  }
  if (!isEmbeddableRelativeSrc(src) || data === undefined || data === null) {
    if (isEmbeddableRelativeSrc(src) && !(src in blockCtx.images)) {
      warn(blockCtx.warnings, `缺图：${src}`)
    } else if (!isEmbeddableRelativeSrc(src)) {
      warn(blockCtx.warnings, `跳过非相对路径图片：${src}`)
    }
    return { runs: [new TextRun({ text: `[图片：${alt || src}]`, font: bodyFont, size: hp(BODY_PT) })] }
  }
  const sniffed = sniffImage(data)
  if (sniffed === null) {
    warn(blockCtx.warnings, `图片无法嵌入（${src}）：无法识别图片格式或尺寸`)
    return { runs: [new TextRun({ text: `[图片损坏：${alt || src}]`, font: bodyFont, size: hp(BODY_PT), color: 'B91C1C' })] }
  }
  try {
    const width = widthPx
    const height = Math.max(1, Math.round(width * (sniffed.height / sniffed.width)))
    return {
      runs: [new ImageRun({ type: sniffed.type, data, transformation: { width, height } })],
      // 无 alt 时不发 caption 键（ImageRender.caption 是精确可选属性，不是 string | undefined）。
      ...(alt !== '' ? { caption: alt } : {}),
    }
  } catch (exc) {
    warn(blockCtx.warnings, `图片无法嵌入（${src}）：${exc instanceof Error ? exc.message : String(exc)}`)
    return { runs: [new TextRun({ text: `[图片损坏：${alt || src}]`, font: bodyFont, size: hp(BODY_PT), color: 'B91C1C' })] }
  }
}

function imageBlock(token: Tokens.Image, blockCtx: BlockCtx): (Paragraph | Table)[] {
  const render = renderImage(token, blockCtx, inToPx(MAX_IMAGE_WIDTH_IN))
  const out: (Paragraph | Table)[] = [new Paragraph({ children: render.runs })]
  if (render.caption !== undefined) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: render.caption,
        font: { ascii: FONT_LATIN, hAnsi: FONT_LATIN, eastAsia: FONT_BODY_CJK },
        size: hp(LABEL_PT),
        color: '6B7280',
      })],
    }))
  }
  return out
}

// ---------------------------------------------------------------------------
// 行内渲染（蓝本 _render_inline / _add_styled_run）
// ---------------------------------------------------------------------------

export interface InlineRenderCtx extends InlineCtx {
  /** 表头单元格：所有文本 run 强制加粗（蓝本 render_table 对 header runs 的处理）。 */
  boldExtra?: boolean
}

function styledRun(text: string, blockCtx: InlineRenderCtx, code = false): TextRun {
  const bold = (blockCtx.bold ?? 0) > 0 || blockCtx.inHeading === true || blockCtx.boldExtra === true
  const italic = (blockCtx.italic ?? 0) > 0
  const linkUrl = blockCtx.linkUrl !== undefined && isSafeHttpUrl(blockCtx.linkUrl) ? blockCtx.linkUrl : undefined
  // docx 的 IRunOptions 属性是只读且斜体键为 italics（曾误写 italic，斜体样式静默失效），
  // 因此一次性构造完整 options，不做事后属性赋值。
  let font: IRunOptions['font']
  let size: number | undefined
  let color: string | undefined
  if (code) {
    font = { ascii: FONT_CODE, hAnsi: FONT_CODE, eastAsia: FONT_BODY_CJK }
    size = hp(CODE_PT)
    color = '374051'
  } else if (blockCtx.inHeading === true) {
    font = { ascii: FONT_LATIN, hAnsi: FONT_LATIN, eastAsia: FONT_HEADING_CJK }
    size = hp(blockCtx.headingPt ?? HEADING_PT[1])
  } else {
    font = { ascii: FONT_LATIN, hAnsi: FONT_LATIN, eastAsia: FONT_BODY_CJK }
    size = hp(BODY_PT)
  }
  if (linkUrl !== undefined) color = '0563C1'
  return new TextRun({
    text,
    bold,
    italics: italic,
    font,
    size,
    ...(color !== undefined ? { color } : {}),
    ...(linkUrl !== undefined ? { underline: {} } : {}),
  })
}

function renderInlineChildren(children: Token[], blockCtx: InlineRenderCtx): (TextRun | ImageRun | ExternalHyperlink)[] {
  const out: (TextRun | ImageRun | ExternalHyperlink)[] = []
  for (const child of children) {
    switch (child.type) {
      case 'text': {
        const nested = inlineChildrenOf(child)
        if (nested.length > 0) out.push(...renderInlineChildren(nested, blockCtx))
        else out.push(styledRun((child as Tokens.Text).text ?? '', blockCtx))
        break
      }
      case 'escape':
        out.push(styledRun((child as Tokens.Text).text ?? '', blockCtx))
        break
      case 'codespan':
        out.push(styledRun((child as Tokens.Codespan).text ?? '', blockCtx, true))
        break
      case 'softbreak':
        out.push(styledRun('\n', blockCtx))
        break
      case 'br':
        out.push(new TextRun({ break: 1 }))
        break
      case 'strong':
        out.push(...renderInlineChildren(inlineChildrenOf(child), { ...blockCtx, bold: (blockCtx.bold ?? 0) + 1 }))
        break
      case 'em':
        out.push(...renderInlineChildren(inlineChildrenOf(child), { ...blockCtx, italic: (blockCtx.italic ?? 0) + 1 }))
        break
      case 'del':
        // 蓝本（commonmark）不解析删除线，文本原样；这里保留内容、不加专属样式。
        out.push(...renderInlineChildren(inlineChildrenOf(child), blockCtx))
        break
      case 'link': {
        const link = child as Tokens.Link
        const href = String(link.href ?? '').trim()
        const inner = renderInlineChildren(link.tokens ?? [], { ...blockCtx, linkUrl: href })
        if (isSafeHttpUrl(href)) {
          out.push(new ExternalHyperlink({ link: href, children: inner }))
        } else {
          out.push(...inner)
        }
        break
      }
      case 'image': {
        // 混排段落里的行内图片 —— 可嵌入则嵌入，否则按蓝本给占位/警告。
        const render = renderImage(child as Tokens.Image, blockCtx, inToPx(INLINE_IMAGE_WIDTH_IN))
        out.push(...render.runs)
        break
      }
      case 'html':
      case 'html_inline':
        // 蓝本 html=False 不产生这些；防御性忽略。
        break
      default:
        break
    }
  }
  return out
}
