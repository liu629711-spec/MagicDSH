/**
 * package_install —— JS（npm/pnpm/yarn）与 Python（pip/uv/poetry）统一装包纪律。
 *
 * 行为蓝本：AgentCore tools/builtin/package_install.py（589 行）。
 * - registry 钉死官方源 + CN 镜像白名单（package_install.py:27-45）；
 * - CLI 里任何覆写 registry / index 的参数一律拒绝（:63-103 黑名单集合 + 正则，
 *   :339-373 reject_registry_override_*）；
 * - 装包形态白名单（:56-60 PM 集合、:119-145 is_install_shaped_argv / _rest_is_install_verb）；
 * - 目录旗标只收工作区相对安全路径（:114-116、:198-209 is_safe_relpath）；
 * - env 钉源（:404-423 registry_pin_env）。
 *
 * 偏离（均已在交付报告中说明）：AgentCore 的 A/B 两轴（云端 allowlist chokepoint +
 * /pkg-cache 预热）依赖其沙箱底座，Magic 不复刻；本工具固定用 spawnSync 在会话
 * 工作区内执行，registry_pin_env 照常注入以钉源；install_cache_env / 权限轴判定
 * （:426-437、:577-589）不适用故省略。
 */

import { spawnSync } from 'node:child_process'

// ── 常量（package_install.py:27-59）───────────────────────────────────────

/** 官方 npm registry + 常见 CN 镜像（:27-31）。env 钉源；CLI 覆写拒绝。 */
export const ALLOWED_NPM_REGISTRIES = [
  'https://registry.npmjs.org/',
  'https://registry.npmmirror.com/',
] as const
export const DEFAULT_NPM_REGISTRY = ALLOWED_NPM_REGISTRIES[0]

/** 仅出网放行的 npm CDN 主机（CDN ≠ 可改 registry，:36-38）。 */
export const ALLOWED_NPM_HOSTS: readonly string[] = ['cdn.npmmirror.com']

/** 官方 PyPI simple index + 常见 CN 镜像（:41-45）。 */
export const ALLOWED_PYPI_REGISTRIES = [
  'https://pypi.org/simple/',
  'https://mirrors.aliyun.com/pypi/simple/',
] as const
export const DEFAULT_PYPI_INDEX = ALLOWED_PYPI_REGISTRIES[0]

/** 仅出网放行的 wheel/sdist 主机（CDN ≠ pin index URL，:48-50）。 */
export const ALLOWED_PYPI_HOSTS: readonly string[] = ['files.pythonhosted.org']

export const JS_INSTALL_VERBS = new Set(['install', 'ci', 'i', 'add'])
export const JS_PM_BINS = new Set(['npm', 'pnpm', 'yarn'])
export const PY_PM_BINS = new Set(['pip', 'poetry', 'uv'])
export const PM_BINS = new Set([...JS_PM_BINS, ...PY_PM_BINS])
export const PYTHON_LAUNCHERS = new Set(['python', 'python3', 'py'])

/** 改包装源旗标黑名单（:63-81）。 */
export const REGISTRY_OVERRIDE_FLAGS = new Set([
  // JS
  '--registry',
  '--reg',
  '--npm-registry',
  '--npmregistryserver',
  // Python（pip / uv / poetry 常见 index 覆写）
  '-i',
  '--index-url',
  '--extra-index-url',
  '--find-links',
  '-f',
  '--index',
  '--default-index',
  '--publish-url',
  '--source',
])

/** `flag=value` 形态黑名单（:83-103，IGNORECASE）。 */
export const REGISTRY_OVERRIDE_RE =
  /^(?:--registry=.+|--reg=.+|--npm-registry=.+|--npmRegistryServer=.+|npmRegistryServer=.+|registry=.+|--@[A-Za-z0-9~._-]+:registry=.+|-i=.+|--index-url=.+|--extra-index-url=.+|--find-links=.+|-f=.+|--index=.+|--default-index=.+|--publish-url=.+|--source=.+)$/i

/** 分段分类时跳过/过滤的 bin（:106-107）——它们仍会在真实 shell 里跑。 */
export const SKIP_BINS = new Set(['cd', 'pushd', 'export', 'unset'])
export const FILTER_BINS = new Set(['grep', 'findstr', 'rg', 'tail', 'head'])

/** 纯重定向 token（:108-110，parse 时剥离）。 */
export const REDIRECT_ONLY = new Set([
  '>', '>>', '<', '2>', '2>>', '&>', '>&', '2>&1', '>&1', '>&2', '|&', '1>', '1>>',
])

/** JS / Python 的安全子目录旗标（:114-116）。 */
export const JS_DIR_FLAGS = new Set(['--prefix', '--dir', '-c', '--cwd'])
// uv/poetry：-C / --directory（统一按小写匹配为 -c）。
export const PY_DIR_FLAGS = new Set(['--directory', '-c', '--project'])

/** 单进程超时与输出截断（对齐 git.ts 的常量风格；蓝本预算见 git_ops/policy.py:156-157）。 */
export const INSTALL_TIMEOUT_MS = 20_000
export const INSTALL_OUTPUT_LIMIT = 16_000

// ── 装包形态判定（:119-195）────────────────────────────────────────────────

/** JS/Python 装包形态 argv（允许先带安全目录旗标）→ true。 */
export function isInstallShapedArgv(argv: readonly string[]): boolean {
  const [pm, rest] = splitPmAndRest(argv)
  if (pm === null || rest.length === 0) return false
  return restIsInstallVerb(pm, rest)
}

function restIsInstallVerb(pm: string, rest: readonly string[]): boolean {
  const verb = (rest[0] ?? '').toLowerCase()
  if (JS_PM_BINS.has(pm)) return JS_INSTALL_VERBS.has(verb)
  if (pm === 'pip') return verb === 'install'
  if (pm === 'poetry') return verb === 'install' || verb === 'add'
  if (pm === 'uv') {
    // uv sync / uv add / uv pip install …
    if (verb === 'sync' || verb === 'add') return true
    return verb === 'pip' && rest.length >= 2 && (rest[1] ?? '').toLowerCase() === 'install'
  }
  return false
}

/** 返回 (pm, 目录旗标之后的 argv)，不认识时 (null, [])。 */
export function splitPmAndRest(argv: readonly string[]): [string | null, string[]] {
  if (argv.length === 0) return [null, []]
  const head = (argv[0] ?? '').toLowerCase()
  let start = 1
  let pm: string | null
  // python -m pip … / python3 -m pip …
  if (PYTHON_LAUNCHERS.has(head)) {
    if (
      argv.length >= 3
      && (argv[1] ?? '').toLowerCase() === '-m'
      && (argv[2] ?? '').toLowerCase() === 'pip'
    ) {
      pm = 'pip'
      start = 3
    } else {
      return [null, []]
    }
  } else if (PM_BINS.has(head)) {
    pm = head
  } else {
    return [null, []]
  }

  const dirFlags = JS_PM_BINS.has(pm) ? JS_DIR_FLAGS : PY_DIR_FLAGS
  let i = start
  scan: while (i < argv.length) {
    const flag = argv[i] ?? ''
    const flagL = flag.toLowerCase()
    if (dirFlags.has(flagL) && i + 1 < argv.length) {
      if (!isSafeRelpath(argv[i + 1] ?? '')) return [null, []]
      i += 2
      continue scan
    }
    for (const prefix of ['--prefix=', '--dir=', '--directory=', '--project=']) {
      if (flagL.startsWith(prefix)) {
        const val = flag.slice(prefix.length)
        if (!isSafeRelpath(val)) return [null, []]
        i += 1
        continue scan
      }
    }
    break
  }
  return [pm, argv.slice(i)]
}

/** 工作区相对路径才安全：拒绝对路径 / `..` / 空 / 盘符 / ~（:198-209）。 */
export function isSafeRelpath(raw: string): boolean {
  const text = (raw ?? '').trim().replace(/\\/g, '/')
  if (text === '' || text.startsWith('/') || text.startsWith('~')) return false
  if (/^[A-Za-z]:/.test(text)) return false
  if (text === '.' || text === './') return true
  const parts = text.split('/').filter(part => part !== '')
  return parts.length > 0 && !parts.includes('..')
}

// ── shell 分段与 argv 解析（:221-311）─────────────────────────────────────

function binBase(token: string): string {
  const head = (token ?? '').toLowerCase().replace(/\\/g, '/')
  let base = head.split('/').pop() ?? head
  for (const suffix of ['.exe', '.cmd', '.bat', '.com']) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length)
      break
    }
  }
  return base
}

/** posix shlex.split 的 JS 等价实现（引号 + 反斜杠转义；失败时退化空白切分）。 */
export function shlexSplit(text: string): string[] {
  const src = text ?? ''
  const out: string[] = []
  let buf = ''
  let hasToken = false
  let quote: string | null = null
  const push = () => {
    if (hasToken) out.push(buf)
    buf = ''
    hasToken = false
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i] ?? ''
    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        buf += ch
        hasToken = true
      }
      i += 1
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
        i += 1
        continue
      }
      if (ch === '\\' && i + 1 < src.length) {
        const next = src[i + 1] ?? ''
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          buf += next
          hasToken = true
          i += 2
          continue
        }
      }
      buf += ch
      hasToken = true
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1] ?? ''
      hasToken = true
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      push()
      i += 1
      continue
    }
    buf += ch
    hasToken = true
    i += 1
  }
  push()
  if (quote !== null) throw new Error('unterminated quote')
  return out
}

/** 按 && / || / ; / | / |& / 换行分段（引号外），对齐 :221-259。 */
export function splitShellSegments(command: string): string[] {
  const text = command ?? ''
  const segs: string[] = []
  let buf = ''
  let quote: string | null = null
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (quote !== null) {
      buf += ch
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        buf += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      i += 1
      continue
    }
    const two = text.slice(i, i + 2)
    if (ch === '\n' || two === '&&' || two === '||' || two === '|&' || ch === '|' || ch === ';') {
      const piece = buf.trim()
      if (piece !== '') segs.push(piece)
      buf = ''
      i += two === '&&' || two === '||' || two === '|&' ? 2 : 1
      continue
    }
    buf += ch
    i += 1
  }
  const piece = buf.trim()
  if (piece !== '') segs.push(piece)
  return segs
}

/** 剥离重定向 token（仅用于分类，:262-275）。 */
function stripRedirectArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  let skipNext = false
  for (const tok of argv) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const low = tok.toLowerCase()
    if (REDIRECT_ONLY.has(low) || /^\d>>?$/.test(tok)) {
      if (low !== '2>&1' && low !== '>&1' && low !== '>&2' && low !== '|&') skipNext = true
      continue
    }
    if (tok !== '') out.push(tok)
  }
  return out
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=./

function stripLeadingEnvAssigns(argv: readonly string[]): string[] {
  let i = 0
  while (i < argv.length && ENV_ASSIGN_RE.test(argv[i] ?? '')) i += 1
  return argv.slice(i)
}

/** shlex 一个分段并丢弃 2>&1 / > file 形态 token（仅分类用，:278-287）。 */
export function parseSegmentArgv(segment: string): string[] {
  const text = (segment ?? '').trim()
  if (text === '') return []
  let argv: string[]
  try {
    argv = shlexSplit(text)
  } catch {
    argv = text.split(/\s+/).filter(item => item !== '')
  }
  return stripLeadingEnvAssigns(stripRedirectArgv(argv))
}

/** payload 分段的 argv，跳过 cd / export / 输出过滤（:300-311）。 */
export function commandPayloadArgvs(command: string): string[][] {
  const payloads: string[][] = []
  for (const seg of splitShellSegments(command)) {
    const argv = parseSegmentArgv(seg)
    if (argv.length === 0) continue
    const head = binBase(argv[0] ?? '')
    if (SKIP_BINS.has(head) || FILTER_BINS.has(head)) continue
    payloads.push(argv)
  }
  return payloads
}

// ── 拒绝规则（:314-401）────────────────────────────────────────────────────

/** 拒绝字面 cd / pushd 离开工作区（:314-336）。 */
export function rejectWorkspaceCd(command: string): string | undefined {
  for (const seg of splitShellSegments(command)) {
    const argv = parseSegmentArgv(seg)
    if (argv.length === 0) continue
    const head = binBase(argv[0] ?? '')
    if (head !== 'cd' && head !== 'pushd') continue
    const paths = argv.slice(1).filter(item => item !== '--' && !(item.startsWith('-') && item !== '-'))
    if (paths.length === 0) {
      return '命令里的 cd/pushd 不能离开工作区（空 cd 会进家目录）。请用工作区相对子目录，或用 directory 参数。'
    }
    for (const raw of paths) {
      if (raw === '-' || !isSafeRelpath(raw)) {
        return `命令里的 cd/pushd 不能离开工作区（禁止绝对路径 / .. / ~ / /）：${raw}`
      }
    }
  }
  return undefined
}

/** 拒绝原始命令串里的 --registry / --index-url（:339-347）。 */
export function rejectRegistryOverrideInCommand(command: string): string | undefined {
  const low = (command ?? '').toLowerCase()
  if (low.includes('--registry') || low.includes('--index-url')) {
    return (
      '禁止改包装源（检测到 --registry / --index-url）。'
      + `装包固定 allowlist registry（${allowHint()}）；勿传 --registry / --index-url。`
    )
  }
  return undefined
}

function allowHint(): string {
  return `JS: ${ALLOWED_NPM_REGISTRIES.join(', ')}; Python: ${ALLOWED_PYPI_REGISTRIES.join(', ')}`
}

/** 拒绝改 registry / index 的 CLI 参数（:350-373）。 */
export function rejectRegistryOverrideArgv(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    const low = arg.toLowerCase()
    if (REGISTRY_OVERRIDE_FLAGS.has(low)) {
      return (
        `禁止改包装源（检测到 ${arg}）。`
        + `装包固定 allowlist registry（${allowHint()}）；`
        + '勿传 --registry / --index-url / scope:registry / --source。'
      )
    }
    if (REGISTRY_OVERRIDE_RE.test(arg)) {
      return (
        `禁止改包装源（检测到 ${arg}）。`
        + '装包固定 allowlist registry；'
        + '勿传 --registry / --index-url / scope:registry / --source。'
      )
    }
  }
  return undefined
}

/** 装包 argv 安装审查；返回报错文案，undefined = 通过（:376-401）。 */
export function validateInstallArgv(argv: readonly string[]): string | undefined {
  if (!isInstallShapedArgv(argv)) {
    return `不是允许的装包形态：${argv.join(' ')}`
  }
  const regErr = rejectRegistryOverrideArgv(argv)
  if (regErr !== undefined) return regErr
  // 目录旗标取值再校验一遍（split 时已查过，这里对最终 argv 兜底）。
  let i = 0
  while (i < argv.length) {
    const low = (argv[i] ?? '').toLowerCase()
    const isBareFlag = JS_DIR_FLAGS.has(low) || PY_DIR_FLAGS.has(low)
    if (isBareFlag && i + 1 < argv.length) {
      if (!isSafeRelpath(argv[i + 1] ?? '')) {
        return `装包子目录必须是工作区相对安全路径（禁止绝对路径 / ..）：${argv[i + 1] ?? ''}`
      }
      i += 2
      continue
    }
    for (const prefix of ['--prefix=', '--dir=', '--directory=', '--project=']) {
      if (low.startsWith(prefix)) {
        const val = (argv[i] ?? '').slice(prefix.length)
        if (!isSafeRelpath(val)) return `装包子目录必须是工作区相对安全路径：${val}`
      }
    }
    i += 1
  }
  return undefined
}

// ── env 钉源（:404-423）────────────────────────────────────────────────────

/** 把常见包管理器钉到默认 allowlist registry 的 env（argv 覆写仍然拒绝）。 */
export function registryPinEnv(): Record<string, string> {
  const reg = DEFAULT_NPM_REGISTRY
  const pypi = DEFAULT_PYPI_INDEX
  return {
    NPM_CONFIG_REGISTRY: reg,
    npm_config_registry: reg,
    YARN_NPM_REGISTRY_SERVER: reg,
    YARN_REGISTRY: reg,
    // pnpm 读 npm_config_registry / NPM_CONFIG_REGISTRY
    PNPM_REGISTRY: reg,
    // Python: pip / uv / poetry index 钉源
    PIP_INDEX_URL: pypi,
    UV_INDEX_URL: pypi,
    UV_DEFAULT_INDEX: pypi,
    POETRY_PYPI_MIRROR_URL: pypi,
  }
}

// ── argv 组装（:457-574）───────────────────────────────────────────────────

/**
 * 从 workspace profile 组装默认装包 argv（:457-509）。
 * 纯 Python 工作区不许落到 npm install；JS+Python 混合 JS 优先；空 → npm（legacy）。
 */
export function resolveInstallArgv(
  packageManagers: readonly string[],
  workingDirectory: string | undefined,
): string[] {
  const pms = [...(packageManagers ?? [])]
  let jsPm: string | null = null
  for (const candidate of ['pnpm', 'yarn', 'npm']) {
    if (pms.includes(candidate)) {
      jsPm = candidate
      break
    }
  }
  let pyPm: string | null = null
  for (const candidate of ['uv', 'poetry', 'pip']) {
    if (pms.includes(candidate)) {
      pyPm = candidate
      break
    }
  }

  if (pyPm !== null && jsPm === null) return resolvePythonInstallArgv(pyPm, workingDirectory)
  const pm = jsPm ?? 'npm'
  const wd = (workingDirectory ?? '').trim()
  if (wd === '') return [pm, 'install']
  if (pm === 'npm') return ['npm', '--prefix', wd, 'install']
  if (pm === 'pnpm') return ['pnpm', '--dir', wd, 'install']
  return ['yarn', '--cwd', wd, 'install']
}

function resolvePythonInstallArgv(pm: string, workingDirectory: string | undefined): string[] {
  const wd = (workingDirectory ?? '').trim()
  if (pm === 'uv') {
    return wd === '' ? ['uv', 'sync'] : ['uv', '--directory', wd, 'sync']
  }
  if (pm === 'poetry') {
    return wd === '' ? ['poetry', 'install'] : ['poetry', '--directory', wd, 'install']
  }
  // pip
  return wd === ''
    ? ['pip', 'install', '-r', 'requirements.txt']
    : ['pip', 'install', '-r', `${wd}/requirements.txt`]
}

/** 工具参数给了目录且 argv 缺目录旗标时注入安全目录旗标（:512-553）。 */
export function applyWorkingDirectory(argv: readonly string[], workingDirectory: string | undefined): string[] {
  const wd = (workingDirectory ?? '').trim()
  if (wd === '' || argv.length === 0) return [...argv]

  // python -m pip … —— 改写 -r 路径；verb-only install 保持原样
  const head = (argv[0] ?? '').toLowerCase()
  if (PYTHON_LAUNCHERS.has(head)) {
    if (argv.length >= 4 && (argv[1] ?? '').toLowerCase() === '-m' && (argv[2] ?? '').toLowerCase() === 'pip') {
      return applyPipWorkingDirectory(argv, wd, 2)
    }
    return [...argv]
  }

  const pm = head
  if (!PM_BINS.has(pm)) return [...argv]

  // 已带目录旗标则不动
  for (const flag of argv.slice(1)) {
    const low = flag.toLowerCase()
    if (JS_DIR_FLAGS.has(low) || PY_DIR_FLAGS.has(low)) return [...argv]
    if (['--prefix=', '--dir=', '--directory=', '--project='].some(prefix => low.startsWith(prefix))) {
      return [...argv]
    }
  }

  if (pm === 'npm') return ['npm', '--prefix', wd, ...argv.slice(1)]
  if (pm === 'pnpm') return ['pnpm', '--dir', wd, ...argv.slice(1)]
  if (pm === 'yarn') return ['yarn', '--cwd', wd, ...argv.slice(1)]
  if (pm === 'uv') return ['uv', '--directory', wd, ...argv.slice(1)]
  if (pm === 'poetry') return ['poetry', '--directory', wd, ...argv.slice(1)]
  if (pm === 'pip') return applyPipWorkingDirectory(argv, wd, 0)
  return [...argv]
}

function applyPipWorkingDirectory(argv: readonly string[], wd: string, pipAt: number): string[] {
  /** `-r` requirements 路径缺前缀时补 `wd/`（:556-574）。 */
  const out = [...argv]
  let i = pipAt + 1
  while (i < out.length) {
    const token = out[i] ?? ''
    if ((token === '-r' || token === '--requirement') && i + 1 < out.length) {
      const req = out[i + 1] ?? ''
      if (!req.startsWith(`${wd}/`) && isSafeRelpath(req)) out[i + 1] = `${wd}/${req}`
      return out
    }
    if (token.startsWith('--requirement=')) {
      const val = token.slice('--requirement='.length)
      if (val !== '' && !val.startsWith(`${wd}/`) && isSafeRelpath(val)) {
        out[i] = `--requirement=${wd}/${val}`
      }
      return out
    }
    i += 1
  }
  return out
}

// ── 工具层（Magic 复刻：统一工具面）───────────────────────────────────────

export interface PackageInstallToolDeps {
  register(tool: {
    name: string
    description: string
    parameters: unknown
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown, exec?: unknown) => Promise<unknown>
  }): unknown
}

function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function workspaceRootOf(exec: unknown): string {
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)
    ?.agent?.session?.header?.cwd
  if (cwd === undefined || cwd.trim() === '') {
    throw new Error('devtools: 无法确定会话工作区（exec.agent.session.header.cwd 缺失）')
  }
  return cwd
}

interface ExecResult {
  ok: boolean
  output: string
  exitCode: number | null
}

function runInstallCommand(argv: readonly string[], cwd: string): ExecResult {
  const spawned = spawnSync(argv[0] ?? 'npm', argv.slice(1), {
    cwd,
    env: { ...process.env, ...registryPinEnv() },
    timeout: INSTALL_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  if (spawned.error !== undefined) {
    return { ok: false, output: `装包命令执行失败：${String(spawned.error)}`, exitCode: spawned.status }
  }
  let output = `${spawned.stdout ?? ''}${(spawned.stderr ?? '') === '' ? '' : `\n${spawned.stderr ?? ''}`}`.trim()
  if (output.length > INSTALL_OUTPUT_LIMIT) {
    output = `${output.slice(0, INSTALL_OUTPUT_LIMIT)}\n…（装包输出超过 ${INSTALL_OUTPUT_LIMIT} 字符已截断）`
  }
  const ok = spawned.status === 0
  return {
    ok,
    output: `${output}${ok ? '' : `\n（exit ${String(spawned.status)}）`}`.trim() || '（无输出）',
    exitCode: spawned.status,
  }
}

/** 注册 package_install 工具。 */
export function registerPackageInstall(tools: PackageInstallToolDeps): void {
  tools.register({
    name: 'package_install',
    description:
      '统一装包纪律（对齐 AgentCore package_install）：JS（npm/pnpm/yarn）与 Python（pip/uv/poetry）。'
      + 'registry 钉死官方源 + CN 镜像白名单，任何覆写 registry/index 的参数'
      + '（--registry、npmRegistryServer、-i/--index-url、--find-links、--source 等）一律拒绝；'
      + '目录参数只收工作区相对安全路径。给 packages 走默认驱动（JS=npm，Python=pip），'
      + '给 command 则须是单段装包形态命令（如 "pnpm --dir web install"）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ecosystem: { type: 'string', enum: ['js', 'python'], description: '包生态：js（npm/pnpm/yarn）或 python（pip/uv/poetry）。' },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: '要安装的包（可选；缺省 = 按 manifest 安装：npm install / pip install -r requirements.txt）。',
        },
        directory: { type: 'string', description: '工作区相对子目录（可选；须是安全相对路径，不含 .. / 绝对路径）。' },
        command: { type: 'string', description: '完整装包命令（可选；须是装包形态且不得含 registry 覆写参数）。' },
      },
      required: ['ecosystem'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args: unknown, exec?: unknown) {
      const root = workspaceRootOf(exec)
      const raw = (args ?? {}) as {
        ecosystem?: unknown
        packages?: unknown
        directory?: unknown
        command?: unknown
      }
      const ecosystem = raw.ecosystem === 'python' ? 'python' : raw.ecosystem === 'js' ? 'js' : undefined
      if (ecosystem === undefined) {
        throw new Error('package_install: ecosystem 须为 "js" 或 "python"')
      }
      const packages = Array.isArray(raw.packages)
        ? raw.packages.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : []
      const directory = typeof raw.directory === 'string' ? raw.directory.trim() : ''
      const command = typeof raw.command === 'string' ? raw.command.trim() : ''

      if (directory !== '' && !isSafeRelpath(directory)) {
        throw new Error(`package_install: directory 须为工作区相对安全路径（禁止绝对路径 / ..）：${directory}`)
      }
      // 对齐蓝本：命令一律在工作区根执行，子目录走 --prefix/--dir/--cwd/--directory 旗标。
      const cwd = root

      let argv: string[]
      if (command !== '') {
        const cdErr = rejectWorkspaceCd(command)
        if (cdErr !== undefined) throw new Error(`package_install: ${cdErr}`)
        const regErr = rejectRegistryOverrideInCommand(command)
        if (regErr !== undefined) throw new Error(`package_install: ${regErr}`)
        const payloads = commandPayloadArgvs(command)
        if (payloads.length !== 1) {
          throw new Error(
            `package_install: command 须是单段装包命令（收到 ${String(payloads.length)} 段 payload）。`
            + '多段命令请拆开逐次调用。',
          )
        }
        argv = payloads[0] ?? []
        if (argv.length > 0 && !PM_BINS.has((argv[0] ?? '').toLowerCase())
          && !PYTHON_LAUNCHERS.has((argv[0] ?? '').toLowerCase())) {
          throw new Error(`package_install: 不是允许的装包命令（首 token 须是包管理器）：${argv.join(' ')}`)
        }
        const argvErr = validateInstallArgv(argv)
        if (argvErr !== undefined) throw new Error(`package_install: ${argvErr}`)
      } else {
        // 默认驱动（对齐 resolve_install_argv 的 JS-first / pip -r 语义），packages 作为附加参数。
        const base = ecosystem === 'js' ? resolveInstallArgv(['npm'], directory) : resolveInstallArgv(['pip'], directory)
        argv = base
        if (ecosystem === 'js' && packages.length > 0) {
          // npm install <pkg…>；pip 同理追加包名。
          argv = [...argv, ...packages]
        } else if (ecosystem === 'python' && packages.length > 0) {
          // pip 的 -r requirements.txt 缺省语义与显式包名互斥：给包时去掉 -r。
          argv = ['pip', 'install', ...packages]
          argv = applyWorkingDirectory(argv, directory)
        }
        const argvErr = validateInstallArgv(argv)
        if (argvErr !== undefined) throw new Error(`package_install: ${argvErr}`)
      }

      const result = runInstallCommand(argv, cwd)
      if (!result.ok) throw new Error(`package_install 失败：${result.output}`)
      return `装包完成（${argv.join(' ')}）\n${result.output}`
    },
  })
}
