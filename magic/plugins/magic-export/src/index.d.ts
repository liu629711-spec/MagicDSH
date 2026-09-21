/**
 * magic-export 插件入口：name / inject / apply。
 *
 * 行为蓝本：AgentCore tools/builtin/{md_to_docx,md_to_pdf}.py +
 * docs_export/{workspace_export,layout}.py（逐项对齐：参数、输出口径、错误消息）。
 * 蓝本是两个独立工具（md_to_docx / md_to_pdf），这里同样注册两个同名工具：
 * 入参只有 path（工作区内 .md/.markdown 相对路径）与 layout 档位，输出为同目录同名
 * .docx / .pdf（蓝本 docx_path_for_markdown / pdf_path_for_markdown 的兄弟文件规则）。
 *
 * 不 import 任何 @deepseek-ai/*：宿主服务鸭子类型，工作区根取
 * exec.agent.session.header.cwd（DSH 原生约定），路径 helpers 复制自 magic-devtools。
 */
import { type ExportExec } from './paths.ts';
export declare const name = "magic-export";
/** Cordis 服务名（不是包名）。 */
export declare const inject: string[];
type ToolExec = ExportExec | undefined;
interface ToolsService {
    register(tool: {
        name: string;
        description: string;
        parameters: unknown;
        output: {
            schema: Record<string, unknown>;
            render: (args: unknown, value: unknown) => Array<{
                type: 'text';
                text: string;
            }>;
        };
        execute: (args: unknown, exec?: ToolExec) => Promise<unknown>;
    }): unknown;
}
interface ExportContext {
    tools: ToolsService;
}
export interface ExportResult {
    /** 产物的路径（工作区相对路径，`/` 分隔）。 */
    path: string;
    /** 源 Markdown 的工作区相对路径。 */
    source: string;
    bytes: number;
    warnings: string[];
    /** 回执 manifest 文本（蓝本 execute 的 output 文案）。 */
    manifest: string;
}
export declare function apply(ctx: ExportContext): Promise<void>;
export {};
//# sourceMappingURL=index.d.ts.map