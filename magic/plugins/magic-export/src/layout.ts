/**
 * 排版档位（蓝本：AgentCore docs_export/layout.py 的逐行移植）。
 *
 * 首行缩进两字是中文正式文书的通例，放到技术文档上却很怪；Markdown 本身不带
 * 「这是不是公文」的信号。所以档位由调用方（工具入参）显式给出，转换器**不**看正文
 * 内容猜——没有任何内容启发式。一级标题居中不在档位内：Word 大标题居中是通例，
 * 两个档位都开。
 */

export type DocLayout = 'standard' | 'official'

export const LAYOUT_STANDARD: DocLayout = 'standard'
export const LAYOUT_OFFICIAL: DocLayout = 'official'

export const DOC_LAYOUTS: readonly DocLayout[] = [LAYOUT_STANDARD, LAYOUT_OFFICIAL] as const

/** 中文公文通例：正文首行缩进两个字符（随字号走，不是固定磅值）。 */
export const FIRST_LINE_INDENT_CHARS = 2

/** 工具 schema 复用同一段措辞，两个导出器口径一致。 */
export const LAYOUT_PARAM_DESCRIPTION =
  '排版档位（可选，默认 standard）：standard=技术文档/报告；'
  + 'official=中文正式文书（正文首行缩进两字）。用户要起诉状、公函、通知、'
  + '声明等可提交的正式文书时传 official，技术文档别传。'

export const LAYOUT_INVALID_MESSAGE =
  `layout 须为 ${DOC_LAYOUTS.join(' / ')}（留空 = ${LAYOUT_STANDARD}）。`

/**
 * 把调用方给的 layout token 映射到档位；无法识别时返回 null。
 * 空 / 缺省 → standard（现状默认）。未知取值返回 null，由调用方明确报错——
 * 静默降级会让用户以为拿到了公文排版。
 */
export function parseLayout(value: unknown): DocLayout | null {
  const token = String(value ?? '').trim().toLowerCase()
  if (token === '') return LAYOUT_STANDARD
  if (token === LAYOUT_OFFICIAL) return LAYOUT_OFFICIAL
  if (token === LAYOUT_STANDARD) return LAYOUT_STANDARD
  return null
}
