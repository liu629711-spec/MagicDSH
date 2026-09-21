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
import { type DocLayout } from './layout.ts';
/** 蓝本缺 CJK 字体时的警告口径（按本插件实际约束改述，仍是「绝不静默」）。 */
export declare const CJK_FONT_WARNING: string;
export interface MdToPdfResult {
    pdfBytes: Uint8Array;
    warnings: string[];
}
export interface ConvertPdfOptions {
    layout?: DocLayout;
}
export declare function convertMarkdownToPdf(markdown: string, options?: ConvertPdfOptions): Promise<MdToPdfResult>;
//# sourceMappingURL=md-to-pdf.d.ts.map