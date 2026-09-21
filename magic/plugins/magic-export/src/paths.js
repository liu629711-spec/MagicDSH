/**
 * 会话工作区路径解析（复制自 plugins/magic-devtools/src/paths.ts，不跨插件 import）。
 *
 * 根 = 调用方 agent 的会话工作区（DSH 原生约定 exec.agent.session.header.cwd）；
 * 越界（绝对路径 / `..` 逃逸）一律拒绝 —— 对齐 AgentCore
 * `workspace/_paths.normalize_workspace_path` + `_escapes_workspace`。
 */
import { isAbsolute, join, resolve, sep } from 'node:path';
/** 取会话工作区根；拿不到时给出可读报错（非 agent 调用没有 cwd）。 */
export function workspaceRootOf(exec) {
    const cwd = exec?.agent?.session?.header?.cwd;
    if (cwd === undefined || cwd.trim() === '') {
        throw new Error('magic-export: 无法确定会话工作区（exec.agent.session.header.cwd 缺失）');
    }
    return cwd;
}
/** 规范化工作区相对路径：拒空、拒绝对路径、拒 `..` 逃逸；返回已 resolve 的绝对路径。 */
export function resolveInWorkspace(root, relRaw, field) {
    const rel = relRaw.trim();
    if (rel === '')
        throw new Error(`${field} 不能为空：请提供工作区相对路径`);
    if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
        throw new Error(`${field} 须为工作区相对路径（收到绝对路径 \`${rel}\`）`);
    }
    const abs = resolve(root, rel);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (abs !== root && !abs.startsWith(rootWithSep)) {
        throw new Error(`${field} \`${rel}\` 超出工作区范围`);
    }
    return abs;
}
/** 路径是否落在某个目录之下（含相等）。已 resolve 的两个绝对路径之间比较。 */
export function isInside(parent, child) {
    const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
    return child === parent || child.startsWith(parentWithSep);
}
export { join };
//# sourceMappingURL=paths.js.map