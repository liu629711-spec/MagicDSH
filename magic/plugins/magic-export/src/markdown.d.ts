/**
 * Markdown 解析公共层（蓝本：AgentCore docs_export/{md_to_docx,md_to_pdf}.py 的解析辅助）。
 *
 * 蓝本用 markdown-it-py（commonmark + GFM tables，html=False，linkify=False，breaks=False）；
 * 本插件用 marked（GFM 表格默认开启），并按蓝本口径跳过原始 HTML token。
 * 输出路径推导、图片 src 收集 / 相对路径解析、行内纯文本抽取全部对齐蓝本行为。
 */
import { type Token } from 'marked';
export type { Token };
/** CJK 及全角字符（PDF 逐字断行用）。 */
export declare function isCjkChar(ch: string): boolean;
/** 解析 Markdown 为 token 流（CommonMark + GFM 表格；原始 HTML token 由渲染层跳过）。 */
export declare function parseMarkdown(markdown: string): Token[];
/** ``报告.md`` → ``报告.docx``（同目录）。蓝本 docx_path_for_markdown。 */
export declare function docxPathForMarkdown(mdPath: string): string;
/** ``报告.md`` → ``报告.pdf``（同目录）。蓝本 pdf_path_for_markdown。 */
export declare function pdfPathForMarkdown(mdPath: string): string;
/** 收集文档里按出现顺序去重后的图片 src（蓝本 collect_image_srcs）。 */
export declare function collectImageSrcs(tokens: Token[]): string[];
/** 遍历块级 token 树里的全部行内 token（含嵌套 list/blockquote/table cell）。 */
export declare function iterInlineTokens(tokens: Token[]): Generator<Token>;
/** 行内 token 的 children（marked：块内 text/paragraph/heading 的 tokens 即行内 token）。 */
export declare function inlineChildrenOf(token: Token): Token[];
/** True 当 src 像工作区相对路径（不是 URL / data URI / 锚点）。蓝本 is_embeddable_relative_src。 */
export declare function isEmbeddableRelativeSrc(src: string): boolean;
/** 相对图片 src → 工作区相对路径；不安全（`..` 逃逸 / 绝对路径）返回 null。蓝本 resolve_workspace_image_path。 */
export declare function resolveWorkspaceImagePath(mdPath: string, src: string): string | null;
export interface InlineTextResult {
    text: string;
    /** PDF 导出的图片相关警告（蓝本 _inline_text_with_images）。 */
    warnings: string[];
}
/**
 * 行内 token 数组 → 纯文本（链接在文本后补 ` (href)`；图片渲染为 alt 占位 + 明确警告）。
 * 蓝本 md_to_pdf._inline_text_with_images（蓝本收 inline token、这里收其 children —— marked
 * 的块级 token 自带行内 children，没有 markdown-it 的独立 inline token）。
 */
export declare function inlineTextWithImages(children: Token[] | undefined | null): InlineTextResult;
/** 行内 token 数组 → 纯文本（不产生警告；标题渲染用）。蓝本 md_to_pdf._inline_text。 */
export declare function inlineText(children: Token[] | undefined | null): string;
//# sourceMappingURL=markdown.d.ts.map