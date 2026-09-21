import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { test } from 'node:test'

import { parseLayout, LAYOUT_INVALID_MESSAGE, LAYOUT_OFFICIAL, LAYOUT_STANDARD } from '../src/layout.ts'
import { docxPathForMarkdown, pdfPathForMarkdown, collectImageSrcs, resolveWorkspaceImagePath, isEmbeddableRelativeSrc, parseMarkdown } from '../src/markdown.ts'
import { convertMarkdownToDocx } from '../src/md-to-docx.ts'
import { convertMarkdownToPdf, CJK_FONT_WARNING } from '../src/md-to-pdf.ts'
import { PDFDocument } from 'pdf-lib'

const SAMPLE_MD = [
  '# 报告标题',
  '',
  '正文段落，含 **粗体**、*斜体*、`inline code` 和 [链接](https://example.com)。',
  '',
  '## 二级标题',
  '',
  '- 无序一',
  '- 无序二',
  '  - 嵌套项',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '> 引用内容',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| a | b |',
  '',
  '---',
  '',
  '![缺失图](missing.png)',
].join('\n')

// ── 最小 zip 读取器：从中央目录找条目并解压（验证 docx 是合法 zip） ──────────

function readZipEntry(buf: Buffer, name: string): Buffer | null {
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1
  if (eocd < 0) return null
  let count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  while (count-- > 0) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nlen = buf.readUInt16LE(off + 28)
    const elen = buf.readUInt16LE(off + 30)
    const clen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const entryName = buf.toString('utf8', off + 46, off + 46 + nlen)
    if (entryName === name) {
      const lnlen = buf.readUInt16LE(lho + 26)
      const lelen = buf.readUInt16LE(lho + 28)
      const start = lho + 30 + lnlen + lelen
      const data = buf.subarray(start, start + csize)
      return method === 0 ? Buffer.from(data) : inflateRawSync(data)
    }
    off += 46 + nlen + elen + clen
  }
  return null
}

function zipEntryNames(buf: Buffer): string[] {
  const names: string[] = []
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1
  if (eocd < 0) return names
  let count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  while (count-- > 0) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const nlen = buf.readUInt16LE(off + 28)
    names.push(buf.toString('utf8', off + 46, off + 46 + nlen))
    const elen = buf.readUInt16LE(off + 30)
    const clen = buf.readUInt16LE(off + 32)
    off += 46 + nlen + elen + clen
  }
  return names
}

// ── layout 档位（蓝本 layout.py 口径） ──────────────────────────────────────

test('parseLayout：空 → standard，未知 → null（不静默降级）', () => {
  assert.equal(parseLayout(undefined), LAYOUT_STANDARD)
  assert.equal(parseLayout(''), LAYOUT_STANDARD)
  assert.equal(parseLayout(' OFFICIAL '), LAYOUT_OFFICIAL)
  assert.equal(parseLayout('fancy'), null)
  assert.equal(LAYOUT_INVALID_MESSAGE, 'layout 须为 standard / official（留空 = standard）。')
})

// ── 输出路径推导（蓝本 docx/pdf_path_for_markdown） ────────────────────────

test('兄弟文件路径：.md 与 .markdown 都换扩展名，目录保持', () => {
  assert.equal(docxPathForMarkdown('报告.md'), '报告.docx')
  assert.equal(docxPathForMarkdown('docs/报告.markdown'), 'docs/报告.docx')
  assert.equal(docxPathForMarkdown('a\\b\\readme.MD'), 'a/b/readme.docx')
  assert.equal(pdfPathForMarkdown('docs/报告.md'), 'docs/报告.pdf')
  assert.equal(pdfPathForMarkdown('notes.markdown'), 'notes.pdf')
})

// ── 图片 src 收集 / 解析（蓝本 collect_image_srcs / resolve_workspace_image_path） ──

test('图片 src 收集保序去重，相对路径解析拒绝 .. 逃逸与外链', () => {
  const tokens = parseMarkdown('![a](img.png) ![b](img.png) ![c](https://x/y.png) ![d](../escape.png)')
  const srcs = collectImageSrcs(tokens)
  assert.deepEqual(srcs, ['img.png', 'https://x/y.png', '../escape.png'])
  assert.equal(isEmbeddableRelativeSrc('https://x/y.png'), false)
  assert.equal(isEmbeddableRelativeSrc('data:image/png;base64,x'), false)
  assert.equal(isEmbeddableRelativeSrc('img.png'), true)
  assert.equal(resolveWorkspaceImagePath('docs/报告.md', 'img.png'), 'docs/img.png')
  // 蓝本 posixpath.normpath 折叠：docs/../escape.png 仍在工作区内 → 放行；
  // 根级 ../escape.png 越界 → null。
  assert.equal(resolveWorkspaceImagePath('docs/报告.md', '../escape.png'), 'escape.png')
  assert.equal(resolveWorkspaceImagePath('报告.md', '../escape.png'), null)
  assert.equal(resolveWorkspaceImagePath('报告.md', './sub/pic.PNG'), 'sub/pic.PNG')
})

// ── md → docx 全量转换 ─────────────────────────────────────────────────────

test('md→docx：合法 zip（[Content_Types].xml 可查），标题/列表/代码/引用/表格齐全', async () => {
  const { docxBytes, warnings } = await convertMarkdownToDocx(SAMPLE_MD)
  const buf = Buffer.from(docxBytes)

  assert.ok(buf.length > 1000)
  assert.equal(buf[0], 0x50, 'zip magic PK')
  assert.equal(buf[1], 0x4b)
  const names = zipEntryNames(buf)
  assert.ok(names.includes('[Content_Types].xml'), 'unzip 首查 [Content_Types].xml 存在')
  assert.ok(names.includes('word/document.xml'))

  const documentXml = readZipEntry(buf, 'word/document.xml')?.toString('utf8') ?? ''
  assert.match(documentXml, /报告标题/)
  assert.match(documentXml, /粗体/)
  assert.match(documentXml, /斜体/)
  assert.match(documentXml, /inline code/)
  assert.match(documentXml, /无序一/)
  assert.match(documentXml, /嵌套项/)
  assert.match(documentXml, /有序一/)
  assert.match(documentXml, /引用内容/)
  assert.match(documentXml, /const x = 1/)
  assert.match(documentXml, /列一/)
  assert.match(documentXml, /─{24}/)
  assert.match(documentXml, /js/, '代码围栏语言标签保留')
  // 缺图：明确警告 + 占位（绝不静默）；未预查字节时占位口径为 [图片：…]（蓝本同逻辑）
  assert.ok(warnings.includes('缺图：missing.png'), JSON.stringify(warnings))
  assert.match(documentXml, /\[图片：缺失图\]/)
  // 链接是外部超链接关系
  const relsXml = readZipEntry(buf, 'word/_rels/document.xml.rels')?.toString('utf8') ?? ''
  assert.match(relsXml, /https:\/\/example\.com/)
})

test('md→docx：official 档写 firstLineChars=200，standard 档不缩进', async () => {
  const official = await convertMarkdownToDocx('正文段落。\n\n第二段。', { layout: LAYOUT_OFFICIAL })
  const officialXml = readZipEntry(Buffer.from(official.docxBytes), 'word/document.xml')?.toString('utf8') ?? ''
  assert.match(officialXml, /w:firstLineChars="200"/)

  const standard = await convertMarkdownToDocx('正文段落。', { layout: LAYOUT_STANDARD })
  const standardXml = readZipEntry(Buffer.from(standard.docxBytes), 'word/document.xml')?.toString('utf8') ?? ''
  assert.doesNotMatch(standardXml, /firstLineChars/)
})

test('md→docx：非相对路径图片给「跳过」警告与占位，不中断导出', async () => {
  const { warnings } = await convertMarkdownToDocx('![remote](https://example.com/a.png)')
  assert.ok(warnings.includes('跳过非相对路径图片：https://example.com/a.png'), JSON.stringify(warnings))
})

test('md→docx：嵌入相对路径图片（传入字节）且有图注', async () => {
  // 1x1 PNG（公开的基线最小图）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const { docxBytes, warnings } = await convertMarkdownToDocx('![徽标](img/logo.png)', {
    images: { 'img/logo.png': new Uint8Array(png) },
  })
  assert.equal(warnings.length, 0, JSON.stringify(warnings))
  const names = zipEntryNames(Buffer.from(docxBytes))
  assert.ok(names.some((n) => n.startsWith('word/media/')), '图片进入 media 目录')
  const documentXml = readZipEntry(Buffer.from(docxBytes), 'word/document.xml')?.toString('utf8') ?? ''
  assert.match(documentXml, /徽标/, 'alt 作为居中图注')
})

// ── md → pdf 全量转换 ──────────────────────────────────────────────────────

test('md→pdf：%PDF 头、pdf-lib 可回读且页数>0，缺 CJK 字体有明确警告', async () => {
  const { pdfBytes, warnings } = await convertMarkdownToPdf(SAMPLE_MD)
  const buf = Buffer.from(pdfBytes)
  assert.match(buf.toString('latin1', 0, 5), /^%PDF-/)

  const pdf = await PDFDocument.load(buf)
  assert.ok(pdf.getPageCount() > 0)

  assert.ok(warnings.includes(CJK_FONT_WARNING), '缺 CJK 字体绝不静默')
  assert.ok(warnings.includes('PDF 导出不嵌入图片：missing.png'), JSON.stringify(warnings))
})

test('md→pdf：长文档自动分页（页数 > 1）', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `第 ${String(i)} 段：some filler text for pagination.`).join('\n\n')
  const { pdfBytes } = await convertMarkdownToPdf(`# Long\n\n${long}\n`)
  const pdf = await PDFDocument.load(Buffer.from(pdfBytes))
  assert.ok(pdf.getPageCount() >= 2, `期望多页，实际 ${String(pdf.getPageCount())}`)
})

test('md→pdf：CJK 与列表/表格/代码不崩溃，不可编码字符替换为 ?（有警告前提）', async () => {
  const { pdfBytes } = await convertMarkdownToPdf('中文段落 with **bold** and `code`.\n\n- 项目一\n\n| 甲 | 乙 |\n| - | - |\n\n```py\nprint("hi")\n```')
  const pdf = await PDFDocument.load(Buffer.from(pdfBytes))
  assert.equal(pdf.getPageCount(), 1)
})
