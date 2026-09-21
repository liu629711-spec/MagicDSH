import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALLOWED_NPM_REGISTRIES,
  ALLOWED_PYPI_REGISTRIES,
  DEFAULT_NPM_REGISTRY,
  DEFAULT_PYPI_INDEX,
  JS_PM_BINS,
  PY_PM_BINS,
  applyWorkingDirectory,
  commandPayloadArgvs,
  isInstallShapedArgv,
  isSafeRelpath,
  parseSegmentArgv,
  rejectRegistryOverrideArgv,
  rejectRegistryOverrideInCommand,
  rejectWorkspaceCd,
  registryPinEnv,
  resolveInstallArgv,
  splitPmAndRest,
  splitShellSegments,
  shlexSplit,
  validateInstallArgv,
  registerPackageInstall,
} from '../src/package-install.ts'

// ── 白名单 / 常量（package_install.py:27-59）───────────────────────────────

test('registry 白名单钉死官方源 + CN 镜像', () => {
  assert.deepEqual([...ALLOWED_NPM_REGISTRIES], ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'])
  assert.deepEqual([...ALLOWED_PYPI_REGISTRIES], ['https://pypi.org/simple/', 'https://mirrors.aliyun.com/pypi/simple/'])
  assert.equal(DEFAULT_NPM_REGISTRY, 'https://registry.npmjs.org/')
  assert.equal(DEFAULT_PYPI_INDEX, 'https://pypi.org/simple/')
})

test('包管理器与 JS/Python 驱动集合对齐蓝本', () => {
  for (const pm of ['npm', 'pnpm', 'yarn']) assert.ok(JS_PM_BINS.has(pm))
  for (const pm of ['pip', 'poetry', 'uv']) assert.ok(PY_PM_BINS.has(pm))
})

// ── 参数黑名单：registry 覆写一律拒绝（:63-103, :350-373）─────────────────

test('rejectRegistryOverrideArgv 拒绝裸旗标与 = 形态', () => {
  for (const bad of [
    '--registry',
    '--reg',
    '--npm-registry',
    '-i',
    '--index-url',
    '--extra-index-url',
    '--find-links',
    '-f',
    '--source',
  ]) {
    assert.match(rejectRegistryOverrideArgv(['npm', 'install', bad]) ?? '', /禁止改包装源/, bad)
  }
  for (const bad of [
    '--registry=https://evil.example/',
    '--npmRegistryServer=https://evil.example/',
    'npmRegistryServer=https://evil.example/',
    'registry=https://evil.example/',
    '--@scope:registry=https://evil.example/',
    '--index-url=http://evil/pypi/simple',
    '-i=http://evil/pypi/simple',
  ]) {
    assert.match(rejectRegistryOverrideArgv(['pip', 'install', bad]) ?? '', /禁止改包装源/, bad)
  }
  assert.equal(rejectRegistryOverrideArgv(['npm', 'install', 'left-pad']), undefined)
  assert.equal(rejectRegistryOverrideArgv(['pip', 'install', 'requests']), undefined)
})

test('rejectRegistryOverrideInCommand 拒绝原始命令串覆写', () => {
  assert.match(rejectRegistryOverrideInCommand('npm install --registry https://evil') ?? '', /禁止改包装源/)
  assert.match(rejectRegistryOverrideInCommand('pip install -r req.txt --index-url http://evil') ?? '', /禁止改包装源/)
  assert.equal(rejectRegistryOverrideInCommand('npm install'), undefined)
})

// ── 装包形态白名单（:119-195）──────────────────────────────────────────────

test('isInstallShapedArgv 识别 JS/Python 装包形态', () => {
  assert.equal(isInstallShapedArgv(['npm', 'install']), true)
  assert.equal(isInstallShapedArgv(['npm', 'install', 'left-pad']), true)
  assert.equal(isInstallShapedArgv(['npm', '--prefix', 'sub', 'install']), true)
  assert.equal(isInstallShapedArgv(['pnpm', 'add', 'react']), true)
  assert.equal(isInstallShapedArgv(['yarn', 'ci']), true)
  assert.equal(isInstallShapedArgv(['pip', 'install', '-r', 'requirements.txt']), true)
  assert.equal(isInstallShapedArgv(['poetry', 'add', 'flask']), true)
  assert.equal(isInstallShapedArgv(['uv', 'sync']), true)
  assert.equal(isInstallShapedArgv(['uv', 'pip', 'install', 'flask']), true)
  assert.equal(isInstallShapedArgv(['python', '-m', 'pip', 'install', 'flask']), true)
  // 非装包形态
  assert.equal(isInstallShapedArgv(['npm', 'run', 'build']), false)
  assert.equal(isInstallShapedArgv(['pip', 'uninstall', 'flask']), false)
  assert.equal(isInstallShapedArgv(['uv', 'pip', 'list']), false)
  assert.equal(isInstallShapedArgv(['node', 'index.js']), false)
  assert.equal(isInstallShapedArgv([]), false)
})

test('splitPmAndRest 跳过安全目录旗标，不安全目录值整段作废', () => {
  assert.deepEqual(splitPmAndRest(['npm', '--prefix', 'web', 'install']), ['npm', ['install']])
  assert.deepEqual(splitPmAndRest(['pnpm', '--dir=web', 'install']), ['pnpm', ['install']])
  assert.deepEqual(splitPmAndRest(['uv', '--directory', 'sub', 'sync']), ['uv', ['sync']])
  assert.deepEqual(splitPmAndRest(['python', '-m', 'pip', 'install', 'x']), ['pip', ['install', 'x']])
  // 目录值不安全 → (null, [])
  assert.deepEqual(splitPmAndRest(['npm', '--prefix', '/abs', 'install']), [null, []])
  assert.deepEqual(splitPmAndRest(['pnpm', '--dir', '../out', 'install']), [null, []])
})

// ── is_safe_relpath（:198-209）─────────────────────────────────────────────

test('isSafeRelpath 只放行工作区相对安全路径', () => {
  assert.equal(isSafeRelpath('web'), true)
  assert.equal(isSafeRelpath('web/sub'), true)
  assert.equal(isSafeRelpath('.'), true)
  assert.equal(isSafeRelpath('./'), true)
  assert.equal(isSafeRelpath(''), false)
  assert.equal(isSafeRelpath('/abs'), false)
  assert.equal(isSafeRelpath('~'), false)
  assert.equal(isSafeRelpath('C:/ws'), false)
  assert.equal(isSafeRelpath('..'), false)
  assert.equal(isSafeRelpath('a/../b'), false)
})

// ── validateInstallArgv（:376-401）─────────────────────────────────────────

test('validateInstallArgv：形态不符与 registry 覆写都拒绝', () => {
  assert.equal(validateInstallArgv(['npm', 'install', 'left-pad']), undefined)
  assert.equal(validateInstallArgv(['pnpm', '--dir', 'web', 'install']), undefined)
  assert.match(validateInstallArgv(['npm', 'run', 'dev']) ?? '', /不是允许的装包形态/)
  assert.match(validateInstallArgv(['npm', 'install', '--registry=https://evil']) ?? '', /禁止改包装源/)
  assert.match(
    validateInstallArgv(['pip', 'install', '-i', 'http://evil/pypi/simple']) ?? '',
    /禁止改包装源/,
  )
  assert.match(validateInstallArgv(['npm', '--prefix', '/abs', 'install']) ?? '', /不是允许的装包形态|工作区相对安全路径/)
  assert.match(validateInstallArgv(['pnpm', '--dir', '../out', 'install']) ?? '', /不是允许的装包形态|工作区相对安全路径/)
})

// ── shell 分段 / argv 解析（:221-311）──────────────────────────────────────

test('splitShellSegments 按引号外分隔符分段', () => {
  assert.deepEqual(splitShellSegments('npm install && pip install -r req.txt'), ['npm install', 'pip install -r req.txt'])
  assert.deepEqual(splitShellSegments('npm install; yarn install | tail'), ['npm install', 'yarn install', 'tail'])
  assert.deepEqual(splitShellSegments('npm install "a && b"'), ['npm install "a && b"'])
  assert.deepEqual(splitShellSegments(''), [])
})

test('shlexSplit 支持 posix 引号与转义', () => {
  assert.deepEqual(shlexSplit('npm install "pkg a" \'b c\''), ['npm', 'install', 'pkg a', 'b c'])
  assert.deepEqual(shlexSplit('pip install a\\ b'), ['pip', 'install', 'a b'])
  assert.deepEqual(shlexSplit('uv sync'), ['uv', 'sync'])
})

test('parseSegmentArgv 剥离重定向与环境变量赋值', () => {
  assert.deepEqual(parseSegmentArgv('FOO=1 npm install > out.log 2>&1'), ['npm', 'install'])
  assert.deepEqual(parseSegmentArgv('npm install 2> err.txt'), ['npm', 'install'])
})

test('commandPayloadArgvs 跳过 cd/export/输出过滤段', () => {
  assert.deepEqual(commandPayloadArgvs('cd web && npm install'), [['npm', 'install']])
  assert.deepEqual(commandPayloadArgvs('export FOO=1 && pnpm install | tail'), [['pnpm', 'install']])
  assert.deepEqual(commandPayloadArgvs('rg needle && npm install'), [['npm', 'install']])
})

test('rejectWorkspaceCd 拒绝离开工作区的 cd/pushd', () => {
  assert.match(rejectWorkspaceCd('cd /tmp && npm install') ?? '', /不能离开工作区/)
  assert.match(rejectWorkspaceCd('cd .. && npm install') ?? '', /不能离开工作区/)
  assert.match(rejectWorkspaceCd('cd - && npm install') ?? '', /不能离开工作区/)
  assert.match(rejectWorkspaceCd('cd') ?? '', /不能离开工作区/)
  assert.equal(rejectWorkspaceCd('cd web && npm install'), undefined)
  assert.equal(rejectWorkspaceCd('npm install'), undefined)
})

// ── env 钉源 / argv 组装（:404-423, :457-574）──────────────────────────────

test('registryPinEnv 钉住全部常见包管理器', () => {
  const env = registryPinEnv()
  assert.equal(env.NPM_CONFIG_REGISTRY, DEFAULT_NPM_REGISTRY)
  assert.equal(env.npm_config_registry, DEFAULT_NPM_REGISTRY)
  assert.equal(env.YARN_REGISTRY, DEFAULT_NPM_REGISTRY)
  assert.equal(env.PNPM_REGISTRY, DEFAULT_NPM_REGISTRY)
  assert.equal(env.PIP_INDEX_URL, DEFAULT_PYPI_INDEX)
  assert.equal(env.UV_INDEX_URL, DEFAULT_PYPI_INDEX)
  assert.equal(env.UV_DEFAULT_INDEX, DEFAULT_PYPI_INDEX)
  assert.equal(env.POETRY_PYPI_MIRROR_URL, DEFAULT_PYPI_INDEX)
})

test('resolveInstallArgv：JS 优先；纯 Python 不落 npm', () => {
  assert.deepEqual(resolveInstallArgv([], undefined), ['npm', 'install'])
  assert.deepEqual(resolveInstallArgv(['pnpm', 'pip'], 'web'), ['pnpm', '--dir', 'web', 'install'])
  assert.deepEqual(resolveInstallArgv(['pip'], 'sub'), ['pip', 'install', '-r', 'sub/requirements.txt'])
  assert.deepEqual(resolveInstallArgv(['uv'], undefined), ['uv', 'sync'])
  assert.deepEqual(resolveInstallArgv(['poetry'], 'pkg'), ['poetry', '--directory', 'pkg', 'install'])
})

test('applyWorkingDirectory 注入安全目录旗标，已有旗标不动', () => {
  assert.deepEqual(applyWorkingDirectory(['npm', 'install'], 'web'), ['npm', '--prefix', 'web', 'install'])
  assert.deepEqual(applyWorkingDirectory(['npm', 'install'], 'web'), ['npm', '--prefix', 'web', 'install'])
  assert.deepEqual(applyWorkingDirectory(['npm', '--prefix', 'other', 'install'], 'web'), ['npm', '--prefix', 'other', 'install'])
  assert.deepEqual(applyWorkingDirectory(['pip', 'install', '-r', 'req.txt'], 'sub'), ['pip', 'install', '-r', 'sub/req.txt'])
  assert.deepEqual(applyWorkingDirectory(['pip', 'install'], 'sub'), ['pip', 'install'])
  assert.deepEqual(applyWorkingDirectory(['uv', 'sync'], 'pkg'), ['uv', '--directory', 'pkg', 'sync'])
})

// ── 工具层：参数校验（真实安装命令不在单测里跑）───────────────────────────

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function registerToHarness(): { tools: Map<string, RegisteredTool>; register(t: RegisteredTool): unknown } {
  const tools = new Map<string, RegisteredTool>()
  return {
    tools,
    register(tool: RegisteredTool) {
      tools.set(tool.name, tool)
    },
  }
}

function execWithCwd(cwd: string): unknown {
  return { agent: { session: { header: { cwd } } } }
}

test('package_install 工具：缺 cwd / 非法 ecosystem / 覆写 registry 都被拒', async () => {
  const harness = registerToHarness()
  registerPackageInstall(harness)
  const tool = harness.tools.get('package_install')
  assert.ok(tool !== undefined)

  await assert.rejects(() => tool.execute({}, undefined), /无法确定会话工作区/)
  await assert.rejects(
    () => tool.execute({ ecosystem: 'rust' }, execWithCwd('.')),
    /ecosystem/,
  )
  await assert.rejects(
    () => tool.execute({ ecosystem: 'js', command: 'npm install --registry https://evil' }, execWithCwd('.')),
    /禁止改包装源/,
  )
  await assert.rejects(
    () => tool.execute({ ecosystem: 'js', command: 'cd .. && npm install' }, execWithCwd('.')),
    /不能离开工作区/,
  )
  await assert.rejects(
    () => tool.execute({ ecosystem: 'js', command: 'npm install && npm install' }, execWithCwd('.')),
    /单段/,
  )
  await assert.rejects(
    () => tool.execute({ ecosystem: 'js', command: 'npm run build' }, execWithCwd('.')),
    /不是允许的装包形态/,
  )
  await assert.rejects(
    () => tool.execute({ ecosystem: 'js', directory: '../out' }, execWithCwd('.')),
    /工作区相对安全路径/,
  )
})

test('package_install 工具：package specs 里夹带 registry 覆写也被拒', async () => {
  const harness = registerToHarness()
  registerPackageInstall(harness)
  const tool = harness.tools.get('package_install')
  assert.ok(tool !== undefined)
  await assert.rejects(
    () => tool.execute({ ecosystem: 'js', packages: ['left-pad', '--registry=https://evil'] }, execWithCwd('.')),
    /禁止改包装源/,
  )
  await assert.rejects(
    () => tool.execute({ ecosystem: 'python', packages: ['requests', '-i', 'http://evil'] }, execWithCwd('.')),
    /禁止改包装源/,
  )
})
