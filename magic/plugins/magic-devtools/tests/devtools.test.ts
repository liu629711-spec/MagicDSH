import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectSources, unzipInto, zipFiles, safeEntryName } from '../src/archive.ts'
import { inspectArgs, isWriteCall, runGit, ALLOWED_SUBCOMMANDS, FORBIDDEN_SUBCOMMANDS } from '../src/git.ts'
import { resolveInWorkspace, workspaceRootOf } from '../src/paths.ts'

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'magic-devtools-'))
}

// ── paths ──────────────────────────────────────────────────────────────────

test('workspaceRootOf 缺 cwd 时给出可读报错', () => {
  assert.throws(() => workspaceRootOf(undefined), /无法确定会话工作区/)
  assert.throws(() => workspaceRootOf({ agent: { session: { header: {} } } }), /无法确定会话工作区/)
  assert.equal(workspaceRootOf({ agent: { session: { header: { cwd: 'D:/ws' } } } }), 'D:/ws')
})

test('resolveInWorkspace 拒绝绝对路径与 .. 逃逸，接受正常相对路径', () => {
  const root = tempWorkspace()
  assert.throws(() => resolveInWorkspace(root, 'C:/evil', 'dest'), /绝对路径/)
  assert.throws(() => resolveInWorkspace(root, '../evil', 'dest'), /超出工作区/)
  const ok = resolveInWorkspace(root, 'sub/dir/file.txt', 'dest')
  assert.ok(ok.startsWith(root))
  rmSync(root, { recursive: true, force: true })
})

// ── archive ────────────────────────────────────────────────────────────────

test('archive 打包剪枝 .git 与 node_modules，往返一致', () => {
  const root = tempWorkspace()
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1\n')
  writeFileSync(join(root, 'README.md'), '# demo\n')
  writeFileSync(join(root, 'node_modules', 'pkg', 'i.js'), 'noise')
  writeFileSync(join(root, '.git', 'HEAD'), 'noise')

  const files = collectSources(root, ['.'])
  assert.equal(files.length, 2)
  const zip = zipFiles(files)
  const dest = tempWorkspace()
  const { fileCount } = unzipInto(zip, dest)
  assert.equal(fileCount, 2)
  assert.equal(readFileSync(join(dest, 'src', 'app.ts'), 'utf8'), 'export const x = 1\n')
  assert.equal(existsSync(join(dest, 'node_modules')), false)
  rmSync(root, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
})

test('archive_extract 拒绝 zip-slip 条目', () => {
  const dest = tempWorkspace()
  assert.throws(() => safeEntryName(dest, dest, '../evil.txt'), /zip-slip/)
  assert.throws(() => safeEntryName(dest, dest, '/abs/evil.txt'), /zip-slip/)
  const ok = safeEntryName(dest, dest, 'sub/ok.txt')
  assert.ok(ok.startsWith(dest))
  rmSync(dest, { recursive: true, force: true })
})

// ── git_ops 策略 ───────────────────────────────────────────────────────────

test('git 白名单与硬禁对齐 AgentCore 策略', () => {
  for (const cmd of ['status', 'diff', 'log', 'add', 'commit', 'push']) {
    assert.ok(ALLOWED_SUBCOMMANDS.has(cmd), cmd)
  }
  assert.ok(FORBIDDEN_SUBCOMMANDS.has('reset'))
  assert.ok(FORBIDDEN_SUBCOMMANDS.has('clean'))
})

test('git_ops 拒绝白名单外子命令、force 与全树 add', () => {
  const ws = tempWorkspace()
  const refused = runGit(ws, 'reset', ['--hard'], undefined)
  assert.equal(refused.ok, false)
  assert.match(refused.output, /硬性拒绝/)

  const notAllowed = runGit(ws, 'config', ['user.name', 'x'], undefined)
  assert.equal(notAllowed.ok, false)
  assert.match(notAllowed.output, /不在白名单/)

  const force = runGit(ws, 'push', ['--force', 'origin', 'main'], undefined)
  assert.equal(force.ok, false)
  assert.match(force.output, /--force/)

  const wholeTree = runGit(ws, 'add', ['.'], undefined)
  assert.equal(wholeTree.ok, false)
  assert.match(wholeTree.output, /明确的工作区相对路径/)

  const pr = runGit(ws, 'create_pr', [], undefined)
  assert.equal(pr.ok, false)
  assert.match(pr.output, /二期/)
  rmSync(ws, { recursive: true, force: true })
})

test('git_ops 写调用判定覆盖恒写集与动作写映射', () => {
  assert.equal(isWriteCall('commit', ['-m', 'x']), true)
  assert.equal(isWriteCall('status', []), false)
  assert.equal(isWriteCall('stash', ['push']), true)
  assert.equal(isWriteCall('stash', ['list']), false)
  assert.equal(isWriteCall('tag', ['create', 'v1']), true)
  assert.equal(isWriteCall('tag', []), false)
})

test('git_ops 在真实仓库走通 init→add→commit→log（需要 git 可用）', () => {
  const ws = tempWorkspace()
  const prev = {
    author: process.env.GIT_AUTHOR_NAME,
    email: process.env.GIT_AUTHOR_EMAIL,
    committer: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  }
  process.env.GIT_AUTHOR_NAME = 't'
  process.env.GIT_AUTHOR_EMAIL = 't@t'
  process.env.GIT_COMMITTER_NAME = 't'
  process.env.GIT_COMMITTER_EMAIL = 't@t'
  try {
    const init = runGit(ws, 'init_baseline', [], undefined)
    assert.equal(init.ok, true)

    writeFileSync(join(ws, 'a.txt'), 'hello\n')
    const add = runGit(ws, 'add', ['a.txt'], undefined)
    assert.equal(add.ok, true)
    assert.equal(isWriteCall('add', ['a.txt']), true)

    const commit = runGit(ws, 'commit', ['-m', 'init'], undefined)
    assert.equal(commit.ok, true)

    const log = runGit(ws, 'log', ['--oneline'], undefined)
    assert.equal(log.ok, true)
    assert.match(log.output, /init/)
  } finally {
    for (const [key, value] of Object.entries(prev) as Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(ws, { recursive: true, force: true })
  }
})
