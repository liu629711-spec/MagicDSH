import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, name, inject } from "../src/index.js";
import { LAYOUT_INVALID_MESSAGE } from "../src/layout.js";
function tempWorkspace() {
    return mkdtempSync(join(tmpdir(), 'magic-export-'));
}
function fakeExec(cwd) {
    return { agent: { session: { header: { cwd } } } };
}
async function loadTools() {
    const registered = [];
    await apply({ tools: { register: (tool) => { registered.push(tool); } } });
    return new Map(registered.map((t) => [t.name, t]));
}
const SAMPLE_MD = [
    '# 季度报告',
    '',
    '本季度 **收入** 增长，`关键指标` 正常，详见 [详情](https://example.com)。',
    '',
    '- 要点一',
    '- 要点二',
    '',
    '```txt',
    'plain code line',
    '```',
].join('\n');
// ── 插件骨架 ───────────────────────────────────────────────────────────────
test('插件导出 name/inject，apply 注册 md_to_docx 与 md_to_pdf 两个工具', async () => {
    assert.equal(name, 'magic-export');
    assert.deepEqual(inject, ['tools']);
    const tools = await loadTools();
    assert.deepEqual([...tools.keys()].sort(), ['md_to_docx', 'md_to_pdf']);
    for (const tool of tools.values()) {
        const params = tool.parameters;
        assert.deepEqual(params.required, ['path']);
        assert.deepEqual(Object.keys(params.properties).sort(), ['layout', 'path']);
        assert.equal(typeof tool.output.render, 'function');
        assert.equal(typeof tool.execute, 'function');
    }
});
// ── md_to_docx 工具端到端 ──────────────────────────────────────────────────
test('md_to_docx：工作区内 .md → 兄弟 .docx，manifest 口径对齐蓝本', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, '报告.md'), SAMPLE_MD, 'utf8');
    const tools = await loadTools();
    const result = await tools.get('md_to_docx').execute({ path: '报告.md' }, fakeExec(ws));
    assert.equal(result.path, '报告.docx');
    assert.equal(result.source, '报告.md');
    assert.ok(result.bytes > 0);
    assert.deepEqual(result.warnings, []);
    const written = readFileSync(join(ws, '报告.docx'));
    assert.equal(written.length, result.bytes);
    assert.equal(written[0], 0x50); // zip PK
    assert.match(result.manifest, /^已导出 Word：报告\.docx（\d+ 字节）\n/);
    assert.match(result.manifest, /【artifact manifest】\npath: 报告\.docx\nkind: docx\nbytes: \d+\nsource: 报告\.md\nwarnings: （无）\n/);
    assert.match(result.manifest, /【验真】请以本 manifest 确认落盘；可用工作区下载打开 \.docx。/);
    const rendered = tools.get('md_to_docx').output.render({}, result);
    assert.deepEqual(rendered, [{ type: 'text', text: result.manifest }]);
    rmSync(ws, { recursive: true, force: true });
});
test('md_to_pdf：工作区内 .md → 兄弟 .pdf，头部 %PDF，manifest 口径对齐蓝本', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'docs'), { recursive: true });
    writeFileSync(join(ws, 'docs', '报告.md'), SAMPLE_MD, 'utf8');
    const tools = await loadTools();
    const result = await tools.get('md_to_pdf').execute({ path: 'docs/报告.md' }, fakeExec(ws));
    assert.equal(result.path, 'docs/报告.pdf');
    assert.equal(result.source, 'docs/报告.md');
    const written = readFileSync(join(ws, 'docs', '报告.pdf'));
    assert.match(written.toString('latin1', 0, 5), /^%PDF-/);
    assert.match(result.manifest, /^已导出 PDF：docs\/报告\.pdf（\d+ 字节）\n/);
    assert.match(result.manifest, /kind: pdf\nbytes: \d+\nsource: docs\/报告\.md\n/);
    // 本插件固定缺 CJK 内嵌字体 → 回执带明确警告（蓝本同分支口径）
    assert.match(result.manifest, /warnings:\n  - 未找到可用的 CJK 字体/);
    rmSync(ws, { recursive: true, force: true });
});
test('layout 档位透传：official 导出成功且产物落盘（缩进结构断言在 convert.test.ts）', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, '公文.md'), '正文第一段。', 'utf8');
    const tools = await loadTools();
    const result = await tools.get('md_to_docx').execute({ path: '公文.md', layout: 'official' }, fakeExec(ws));
    assert.equal(result.path, '公文.docx');
    assert.deepEqual(result.warnings, []);
    assert.ok(readFileSync(join(ws, '公文.docx')).length > 0);
    rmSync(ws, { recursive: true, force: true });
});
// ── 安全 / 错误口径（对齐蓝本 workspace_export） ────────────────────────────
test('错误口径：空 path / 非 .md 源 / 无效 layout', async () => {
    const ws = tempWorkspace();
    const tools = await loadTools();
    const docx = tools.get('md_to_docx');
    const pdf = tools.get('md_to_pdf');
    await assert.rejects(docx.execute({}, fakeExec(ws)), /path 不能为空：请提供工作区内的 \.md 相对路径/);
    await assert.rejects(pdf.execute({ path: '  ' }, fakeExec(ws)), /path 不能为空/);
    await assert.rejects(docx.execute({ path: 'notes.txt' }, fakeExec(ws)), /仅支持 Markdown 文件（\.md \/ \.markdown）：notes\.txt/);
    await assert.rejects(pdf.execute({ path: 'notes.rst' }, fakeExec(ws)), /仅支持 Markdown 文件/);
    await assert.rejects(docx.execute({ path: 'a.md', layout: 'fancy' }, fakeExec(ws)), new RegExp(LAYOUT_INVALID_MESSAGE));
    rmSync(ws, { recursive: true, force: true });
});
test('安全：越界源 / 越界图片 / 缺源 / 缺工作区根均拒绝', async () => {
    const ws = tempWorkspace();
    const tools = await loadTools();
    const docx = tools.get('md_to_docx');
    await assert.rejects(docx.execute({ path: '../evil.md' }, fakeExec(ws)), /路径非法：超出工作区范围/);
    await assert.rejects(docx.execute({ path: 'C:/evil.md' }, fakeExec(ws)), /路径非法：超出工作区范围/);
    // 蓝本 _normalize_md_path 会剥掉前导 `/`：/abs/evil.md 被当作工作区内 abs/evil.md
    await assert.rejects(docx.execute({ path: '/abs/evil.md' }, fakeExec(ws)), /源文件不存在：abs\/evil\.md/);
    await assert.rejects(docx.execute({ path: 'missing.md' }, fakeExec(ws)), /源文件不存在：missing\.md/);
    mkdirSync(join(ws, 'fake.md'), { recursive: true }); // 蓝本口径：后缀校验先于存在性——目录须带 .md 后缀才走到「不是文件」
    await assert.rejects(docx.execute({ path: 'fake.md' }, fakeExec(ws)), /不是文件：fake\.md/);
    await assert.rejects(docx.execute({ path: 'a.md' }, undefined), /无法确定会话工作区/);
    await assert.rejects(docx.execute({ path: 'a.md' }, {}), /无法确定会话工作区/);
    // 越界图片：不中断导出，记「缺图」警告（蓝本同口径——查不到即 null）
    writeFileSync(join(ws, 'with-img.md'), '![x](../outside.png)', 'utf8');
    const result = await docx.execute({ path: 'with-img.md' }, fakeExec(ws));
    assert.ok(result.warnings.includes('缺图：../outside.png'), JSON.stringify(result.warnings));
    rmSync(ws, { recursive: true, force: true });
});
//# sourceMappingURL=tool.test.js.map