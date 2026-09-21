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
import { type DocLayout } from './layout.ts';
export interface MdToDocxResult {
    docxBytes: Uint8Array;
    warnings: string[];
}
export interface ConvertDocxOptions {
    /** src → 图片字节；null 表示查找过但缺失（渲染 [缺图：…] 并警告）。 */
    images?: Record<string, Uint8Array | null>;
    layout?: DocLayout;
}
interface InlineCtx {
    images: Record<string, Uint8Array | null>;
    warnings: string[];
    inHeading?: boolean;
    headingPt?: number;
    bold?: number;
    italic?: number;
    linkUrl?: string;
}
export declare function convertMarkdownToDocx(markdown: string, options?: ConvertDocxOptions): Promise<MdToDocxResult>;
export interface InlineRenderCtx extends InlineCtx {
    /** 表头单元格：所有文本 run 强制加粗（蓝本 render_table 对 header runs 的处理）。 */
    boldExtra?: boolean;
}
export {};
//# sourceMappingURL=md-to-docx.d.ts.map