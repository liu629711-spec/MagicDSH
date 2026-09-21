/**
 * 会话工作区路径解析（复制自 plugins/magic-devtools/src/paths.ts，不跨插件 import）。
 *
 * 根 = 调用方 agent 的会话工作区（DSH 原生约定 exec.agent.session.header.cwd）；
 * 越界（绝对路径 / `..` 逃逸）一律拒绝 —— 对齐 AgentCore
 * `workspace/_paths.normalize_workspace_path` + `_escapes_workspace`。
 */
import { join } from 'node:path';
/** 工具执行上下文里 Magic 用到的最小投影（鸭子类型，不 import DSH）。 */
export interface ExportExec {
    agent?: {
        session?: {
            header?: {
                cwd?: string;
            };
        };
    };
    signal?: AbortSignal;
}
/** 取会话工作区根；拿不到时给出可读报错（非 agent 调用没有 cwd）。 */
export declare function workspaceRootOf(exec: ExportExec | undefined): string;
/** 规范化工作区相对路径：拒空、拒绝对路径、拒 `..` 逃逸；返回已 resolve 的绝对路径。 */
export declare function resolveInWorkspace(root: string, relRaw: string, field: string): string;
/** 路径是否落在某个目录之下（含相等）。已 resolve 的两个绝对路径之间比较。 */
export declare function isInside(parent: string, child: string): boolean;
export { join };
//# sourceMappingURL=paths.d.ts.map