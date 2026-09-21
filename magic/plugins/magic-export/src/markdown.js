/**
 * Markdown 解析公共层（蓝本：AgentCore docs_export/{md_to_docx,md_to_pdf}.py 的解析辅助）。
 *
 * 蓝本用 markdown-it-py（commonmark + GFM tables，html=False，linkify=False，breaks=False）；
 * 本插件用 marked（GFM 表格默认开启），并按蓝本口径跳过原始 HTML token。
 * 输出路径推导、图片 src 收集 / 相对路径解析、行内纯文本抽取全部对齐蓝本行为。
 */
import { marked } from 'marked';
import { dirname as posixDirname, join as posixJoin, normalize as posixNormalize } from 'node:path/posix';
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** CJK 及全角字符（PDF 逐字断行用）。 */
export function isCjkChar(ch) {
    const code = ch.codePointAt(0) ?? 0;
    return ((code >= 0x2e80 && code <= 0x9fff)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe30 && code <= 0xfe4f)
        || (code >= 0xff00 && code <= 0xffef)
        || (code >= 0x3000 && code <= 0x303f));
}
/** 解析 Markdown 为 token 流（CommonMark + GFM 表格；原始 HTML token 由渲染层跳过）。 */
export function parseMarkdown(markdown) {
    return marked.lexer(markdown ?? '');
}
/** ``报告.md`` → ``报告.docx``（同目录）。蓝本 docx_path_for_markdown。 */
export function docxPathForMarkdown(mdPath) {
    return siblingPathFor(mdPath, '.docx');
}
/** ``报告.md`` → ``报告.pdf``（同目录）。蓝本 pdf_path_for_markdown。 */
export function pdfPathForMarkdown(mdPath) {
    return siblingPathFor(mdPath, '.pdf');
}
function siblingPathFor(mdPath, ext) {
    const p = mdPath.replaceAll('\\', '/').trim();
    const lower = p.toLowerCase();
    if (lower.endsWith('.markdown'))
        return p.slice(0, -'.markdown'.length) + ext;
    if (lower.endsWith('.md'))
        return p.slice(0, -'.md'.length) + ext;
    return `${p}${ext}`;
}
/** 收集文档里按出现顺序去重后的图片 src（蓝本 collect_image_srcs）。 */
export function collectImageSrcs(tokens) {
    const seen = new Set();
    const out = [];
    for (const inline of iterInlineTokens(tokens)) {
        if (inline.type !== 'image')
            continue;
        const src = String(inline.href ?? '').trim();
        if (src === '' || seen.has(src))
            continue;
        seen.add(src);
        out.push(src);
    }
    return out;
}
/** 遍历块级 token 树里的全部行内 token（含嵌套 list/blockquote/table cell）。 */
export function* iterInlineTokens(tokens) {
    for (const token of tokens) {
        switch (token.type) {
            case 'paragraph':
            case 'heading':
            case 'text': {
                for (const child of inlineChildrenOf(token))
                    yield child;
                break;
            }
            case 'list': {
                for (const item of token.items)
                    yield* iterInlineTokens(item.tokens ?? []);
                break;
            }
            case 'blockquote': {
                yield* iterInlineTokens(token.tokens ?? []);
                break;
            }
            case 'table': {
                const table = token;
                for (const cell of [...table.header, ...table.rows.flat()]) {
                    for (const child of cell.tokens ?? [])
                        yield child;
                }
                break;
            }
            default:
                break;
        }
    }
}
/** 行内 token 的 children（marked：块内 text/paragraph/heading 的 tokens 即行内 token）。 */
export function inlineChildrenOf(token) {
    const withChildren = token;
    return Array.isArray(withChildren.tokens) ? withChildren.tokens : [];
}
/** True 当 src 像工作区相对路径（不是 URL / data URI / 锚点）。蓝本 is_embeddable_relative_src。 */
export function isEmbeddableRelativeSrc(src) {
    const s = (src ?? '').trim();
    if (s === '' || s.startsWith('#'))
        return false;
    if (s.startsWith('data:'))
        return false;
    return !SCHEME_RE.test(s);
}
/** 相对图片 src → 工作区相对路径；不安全（`..` 逃逸 / 绝对路径）返回 null。蓝本 resolve_workspace_image_path。 */
export function resolveWorkspaceImagePath(mdPath, src) {
    if (!isEmbeddableRelativeSrc(src))
        return null;
    let cleaned = decodeURIComponent(src.trim()).replaceAll('\\', '/');
    while (cleaned.startsWith('./'))
        cleaned = cleaned.slice(2);
    const mdDir = posixDirname(mdPath.replaceAll('\\', '/').trim());
    const joined = posixNormalize(mdDir !== '' && mdDir !== '.' ? posixJoin(mdDir, cleaned) : cleaned);
    if (joined.startsWith('../') || joined === '..' || joined.startsWith('/'))
        return null;
    return joined;
}
/**
 * 行内 token 数组 → 纯文本（链接在文本后补 ` (href)`；图片渲染为 alt 占位 + 明确警告）。
 * 蓝本 md_to_pdf._inline_text_with_images（蓝本收 inline token、这里收其 children —— marked
 * 的块级 token 自带行内 children，没有 markdown-it 的独立 inline token）。
 */
export function inlineTextWithImages(children) {
    const warnings = [];
    if (!Array.isArray(children)) {
        return { text: '', warnings };
    }
    const parts = [];
    const linkStack = [];
    const walk = (children) => {
        for (const child of children) {
            switch (child.type) {
                case 'text': {
                    const nested = inlineChildrenOf(child);
                    if (nested.length > 0)
                        walk(nested);
                    else
                        parts.push(child.text ?? '');
                    break;
                }
                case 'escape':
                    parts.push(child.text ?? '');
                    break;
                case 'codespan':
                    parts.push(child.text ?? '');
                    break;
                case 'softbreak':
                case 'br':
                    parts.push('\n');
                    break;
                case 'link': {
                    const link = child;
                    const href = String(link.href ?? '').trim();
                    walk(link.tokens ?? []);
                    if (href !== '')
                        parts.push(` (${href})`);
                    break;
                }
                case 'image': {
                    const image = child;
                    const src = String(image.href ?? '').trim();
                    const alt = (image.text ?? '').trim();
                    const msg = `PDF 导出不嵌入图片：${src !== '' ? src : (alt !== '' ? alt : '(空)')}`;
                    if (!warnings.includes(msg))
                        warnings.push(msg);
                    parts.push(`[图片：${alt !== '' ? alt : src}]`);
                    break;
                }
                case 'strong':
                case 'em':
                case 'del':
                    walk(inlineChildrenOf(child));
                    break;
                default:
                    break;
            }
        }
    };
    walk(children);
    return { text: parts.join(''), warnings };
}
/** 行内 token 数组 → 纯文本（不产生警告；标题渲染用）。蓝本 md_to_pdf._inline_text。 */
export function inlineText(children) {
    return inlineTextWithImages(children).text;
}
//# sourceMappingURL=markdown.js.map