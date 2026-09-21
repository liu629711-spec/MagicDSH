/**
 * 排版档位（蓝本：AgentCore docs_export/layout.py 的逐行移植）。
 *
 * 首行缩进两字是中文正式文书的通例，放到技术文档上却很怪；Markdown 本身不带
 * 「这是不是公文」的信号。所以档位由调用方（工具入参）显式给出，转换器**不**看正文
 * 内容猜——没有任何内容启发式。一级标题居中不在档位内：Word 大标题居中是通例，
 * 两个档位都开。
 */
export type DocLayout = 'standard' | 'official';
export declare const LAYOUT_STANDARD: DocLayout;
export declare const LAYOUT_OFFICIAL: DocLayout;
export declare const DOC_LAYOUTS: readonly DocLayout[];
/** 中文公文通例：正文首行缩进两个字符（随字号走，不是固定磅值）。 */
export declare const FIRST_LINE_INDENT_CHARS = 2;
/** 工具 schema 复用同一段措辞，两个导出器口径一致。 */
export declare const LAYOUT_PARAM_DESCRIPTION: string;
export declare const LAYOUT_INVALID_MESSAGE: string;
/**
 * 把调用方给的 layout token 映射到档位；无法识别时返回 null。
 * 空 / 缺省 → standard（现状默认）。未知取值返回 null，由调用方明确报错——
 * 静默降级会让用户以为拿到了公文排版。
 */
export declare function parseLayout(value: unknown): DocLayout | null;
//# sourceMappingURL=layout.d.ts.map