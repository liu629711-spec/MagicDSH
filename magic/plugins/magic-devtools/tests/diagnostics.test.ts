import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JS_TS_SUFFIXES,
  formatDiagnosticsBlock,
  formatFullOutput,
  isJsTsPath,
  normalizePaths,
  parseTscLine,
  registerCodeDiagnostics,
} from '../src/diagnostics.ts'

// ── 基础判定（write_diagnostics.py:18-26）─────────────────────────────────

test('isJsTsPath 与 JS_TS_SUFFIXES 对齐蓝本', () => {
  assert.deepEqual([...JS_TS_SUFFIXES], ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
  for (const p of ['src/app.ts', 'a\\b\\c.tsx', 'server.mjs', 'X.JS']) {
    assert.equal(isJsTsPath(p), true, p)
  }
  for (const p of ['src/app.py', 'readme.md', 'config.json', 'ts']) {
    assert.equal(isJsTsPath(p), false, p)
  }
})

test('normalizePaths 字符串化、去空、去重、反斜杠转斜杠', () => {
  assert.deepEqual(
    normalizePaths(['src/a.ts', ' src\\b.ts ', '', null, 'src/a.ts', 42]),
    ['src/a.ts', 'src/b.ts', '42'],
  )
  assert.deepEqual(normalizePaths('not-an-array'), [])
})

// ── tsc 输出解析 ───────────────────────────────────────────────────────────

test('parseTscLine 解析 --pretty false 的 file(line,col) 诊断行', () => {
  const item = parseTscLine("src/app.ts(3,5): error TS2322: Type 'number' is not assignable to type 'string'.")
  assert.ok(item !== undefined)
  assert.equal(item.path, 'src/app.ts')
  assert.equal(item.line, 3)
  assert.equal(item.column, 5)
  assert.equal(item.severity, 'error')
  assert.equal(item.code, 'TS2322')
  assert.equal(item.message, "Type 'number' is not assignable to type 'string'.")

  const warn = parseTscLine('src/lib.ts(10,1): warning TS6133: unused variable')
  assert.ok(warn !== undefined)
  assert.equal(warn.severity, 'warning')
  assert.equal(warn.code, 'TS6133')

  // 无错误码的行（部分环境输出 `error: ...`）也能解析。
  const plain = parseTscLine('src/x.ts(1,1): error: boom')
  assert.ok(plain !== undefined)
  assert.equal(plain.code, '')

  // 非诊断行一律忽略。
  for (const line of [
    'Found 3 errors in 2 files.',
    '',
    'error TS18003: No inputs were found in config file.',
    'random text without locations',
  ]) {
    assert.equal(parseTscLine(line), undefined, line)
  }
})

// ── markdown 呈现（code_diagnostics.py:68-119 _format_full_output）────────

test('formatFullOutput：计数头 + 按文件分节', () => {
  const output = formatFullOutput(
    {
      status: 'ok',
      diagnostics: [
        { path: 'src/a.ts', line: 3, column: 5, severity: 'error', code: 'TS2322', message: 'type mismatch' },
        { path: 'src/a.ts', line: 7, column: 1, severity: 'warning', code: 'TS6133', message: 'unused' },
        { path: 'src/b.ts', line: 1, column: 1, severity: 'error', code: 'TS2304', message: 'cannot find name' },
      ],
    },
    ['src/a.ts', 'src/b.ts'],
  )
  const lines = output.split('\n')
  assert.equal(lines[0], '## 内环诊断（code_diagnostics）')
  assert.equal(lines[2], '- 状态：ok')
  assert.equal(lines[3], '- 路径数：2')
  assert.equal(lines[4], '- error：2 · warning：1')
  assert.match(output, /### `src\/a\.ts`/)
  assert.match(output, /- 3:5 error \[TS2322\]: type mismatch/)
  assert.match(output, /- 7:1 warning \[TS6133\]: unused/)
  assert.match(output, /### `src\/b\.ts`/)
  assert.match(output, /- 1:1 error \[TS2304\]: cannot find name/)
})

test('formatFullOutput：无诊断项与 unavailable 的诚实降级', () => {
  const clean = formatFullOutput({ status: 'ok', diagnostics: [] }, ['src/a.ts'])
  assert.match(clean, /- error：0 · warning：0/)
  assert.match(clean, /无诊断项/)

  const unavailable = formatFullOutput(
    { status: 'unavailable', reason: 'tsc 不可用', diagnostics: [] },
    ['src/a.ts'],
  )
  assert.match(unavailable, /内环诊断不可用：tsc 不可用/)
  assert.match(unavailable, /验收请用 run（typecheck\/build\/test）/)
  assert.match(unavailable, /请求路径：src\/a\.ts/)
})

// ── 短块（write_diagnostics.py:29-85 format_diagnostics_block）────────────

test('formatDiagnosticsBlock：errors 优先、按行排序、cap 12', () => {
  const clean = formatDiagnosticsBlock({ status: 'ok', diagnostics: [] }, 'src/a.ts')
  assert.equal(clean, '\n内环诊断：`src/a.ts` 无 error')

  const block = formatDiagnosticsBlock(
    {
      status: 'ok',
      diagnostics: [
        { path: 'src/a.ts', line: 9, column: 1, severity: 'error', code: 'TS1005', message: 'second' },
        { path: 'src/a.ts', line: 2, column: 3, severity: 'error', code: 'TS1003', message: 'first' },
      ],
    },
    'src/a.ts',
  )
  const blockLines = block.split('\n')
  assert.equal(blockLines[1], '内环诊断（code_diagnostics）：')
  assert.equal(blockLines[2], '- `src/a.ts`')
  assert.equal(blockLines[3], '  · 2:3 error [TS1003]: first')
  assert.equal(blockLines[4], '  · 9:1 error [TS1005]: second')

  const many = Array.from({ length: 15 }, (_, i) => ({
    path: 'src/a.ts',
    line: i + 1,
    column: 1,
    severity: 'error',
    code: 'TS0001',
    message: `e${String(i)}`,
  }))
  const capped = formatDiagnosticsBlock({ status: 'ok', diagnostics: many }, 'src/a.ts')
  assert.match(capped, /…另有 3 条 error 省略；可再调 code_diagnostics 看全部/)

  const unavailable = formatDiagnosticsBlock({ status: 'unavailable', reason: 'boom', diagnostics: [] })
  assert.equal(unavailable, '\n内环诊断不可用：boom（验收请用 run）')
})

// ── 工具层：路径越界拒绝 ───────────────────────────────────────────────────

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

test('code_diagnostics 工具：缺 cwd / 空 paths / 越界路径都被拒', async () => {
  const tools = new Map<string, RegisteredTool>()
  registerCodeDiagnostics({ register: tool => tools.set(tool.name, tool as RegisteredTool) })
  const tool = tools.get('code_diagnostics')
  assert.ok(tool !== undefined)

  const exec = (cwd: string) => ({ agent: { session: { header: { cwd } } } })

  await assert.rejects(() => tool.execute({ paths: ['a.ts'] }, undefined), /无法确定会话工作区/)
  await assert.rejects(() => tool.execute({ paths: [] }, exec('.')), /paths 不能为空/)
  await assert.rejects(() => tool.execute({}, exec('.')), /paths 不能为空/)
  await assert.rejects(() => tool.execute({ paths: ['../evil.ts'] }, exec('.')), /超出工作区/)
  await assert.rejects(() => tool.execute({ paths: ['src/../../evil.ts'] }, exec('.')), /超出工作区/)
  await assert.rejects(() => tool.execute({ paths: ['C:/evil.ts'] }, exec('.')), /绝对路径/)
  await assert.rejects(() => tool.execute({ paths: ['/abs/evil.ts'] }, exec('.')), /绝对路径/)
})
