/**
 * git_ops —— 白名单化的 git 子命令调度。
 *
 * 行为蓝本：AgentCore tools/builtin/git_ops/policy.py（21 个白名单子命令、
 * 恒写集、动作写映射、`git add` 拒收 `.` / `-A` / `--all`）与
 * runtime/safety_breaker.py:32-33（禁 `reset` / `clean`；保护 `main` / `master`）。
 * 单进程 20s 超时 + 5s kill slack（policy.py:156-157）；diff 输出 16k 截断、
 * status/blame 行数预算（:151-154）。
 */

import { spawnSync } from 'node:child_process'

/** 白名单子命令（policy.py:17-43）。 */
export const ALLOWED_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'fetch', 'show', 'blame',
  'add', 'commit', 'branch', 'checkout', 'push', 'pull',
  'clone', 'stash', 'merge', 'rebase', 'cherry-pick', 'tag', 'remote',
  'init_baseline', 'create_pr',
])

/** 硬禁子命令（safety_breaker.py:32）——即使有人扩白名单也不许过。 */
export const FORBIDDEN_SUBCOMMANDS = new Set(['reset', 'clean'])

/** 保护分支（safety_breaker.py:33）：force 类操作撞上即拒。 */
export const PROTECTED_BRANCHES = new Set(['main', 'master'])

/** 恒写子命令（policy.py:43-57）。 */
export const ALWAYS_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'branch', 'checkout', 'push', 'pull',
  'init_baseline', 'clone', 'merge', 'rebase', 'cherry-pick', 'create_pr',
])

/** 动作写映射（policy.py:59-63）：只有列出的动作改状态。 */
export const ACTION_WRITE_MAP: Record<string, ReadonlySet<string>> = {
  stash: new Set(['push', 'pop']),
  tag: new Set(['create']),
  remote: new Set(['add']),
}

export const GIT_TIMEOUT_MS = 20_000
export const DIFF_OUTPUT_LIMIT = 16_000
export const STATUS_LINE_LIMIT = 200

const BUDGETED_LINES = new Set(['status', 'blame'])

/** 判定一次调用是否改状态（写）。 */
export function isWriteCall(subcommand: string, args: readonly string[]): boolean {
  if (ALWAYS_WRITE_SUBCOMMANDS.has(subcommand)) return true
  const action = ACTION_WRITE_MAP[subcommand]
  if (action !== undefined) {
    const verb = args.find(item => !item.startsWith('-'))
    return verb !== undefined && action.has(verb)
  }
  return false
}

/** 参数安全审查：返回拒绝原因，undefined = 通过。 */
export function inspectArgs(subcommand: string, args: readonly string[]): string | undefined {
  if (FORBIDDEN_SUBCOMMANDS.has(subcommand)) {
    return `git ${subcommand} 被硬性拒绝（破坏性子命令，对齐 AgentCore safety_breaker）`
  }
  const joined = args.join(' ')
  if (/--force\b|^-f\b/.test(joined) && ['push', 'merge', 'pull'].includes(subcommand)) {
    return `git ${subcommand} --force 被拒绝：先手动评估，再用非 force 方式操作`
  }
  if (subcommand === 'push') {
    const ref = args.find(item => !item.startsWith('-'))
    if (ref !== undefined && PROTECTED_BRANCHES.has(ref.replace(/^.*\//, '')) && /--force|-f\b/.test(joined)) {
      return `push 目标是保护分支 ${ref}，force 已拒绝`
    }
  }
  if (subcommand === 'add') {
    // policy.py:421 —— add 拒收全树入口，要求给出明确的相对路径。
    const wholeTree = args.find(item => ['.', '-A', '--all'].includes(item))
    if (wholeTree !== undefined) {
      return `git add \`${wholeTree}\` 被拒绝：请列出明确的工作区相对路径（对齐 AgentCore 策略）`
    }
  }
  if (subcommand === 'create_pr') {
    return 'create_pr 需要远端凭证面（PRD-05 权限语义待定），二期开放'
  }
  return undefined
}

export interface GitCallResult {
  ok: boolean
  output: string
  exitCode: number | null
  write: boolean
}

/** init_baseline 是 AgentCore 的元命令：落到真实 git 的 `init`。 */
function realGitSubcommand(subcommand: string): string {
  return subcommand === 'init_baseline' ? 'init' : subcommand
}

/** 在工作区内执行一次白名单 git 调用。 */
export function runGit(
  cwd: string,
  subcommand: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): GitCallResult {
  // 硬禁先于白名单判定：reset / clean 属于"破坏性、不可审批"级别（safety_breaker），
  // 与"没进白名单"是两种拒绝语义。
  if (FORBIDDEN_SUBCOMMANDS.has(subcommand)) {
    return { ok: false, output: `git ${subcommand} 被硬性拒绝（破坏性子命令，对齐 AgentCore safety_breaker）`, exitCode: null, write: false }
  }
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return { ok: false, output: `git 子命令 \`${subcommand}\` 不在白名单（允许：${[...ALLOWED_SUBCOMMANDS].sort().join(' ')}）`, exitCode: null, write: false }
  }
  const rejection = inspectArgs(subcommand, args)
  if (rejection !== undefined) return { ok: false, output: rejection, exitCode: null, write: false }

  const spawned = spawnSync('git', ['-C', cwd, realGitSubcommand(subcommand), ...args], {
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
    signal,
  })
  if (spawned.error !== undefined) {
    return {
      ok: false,
      output: `git 执行失败：${String(spawned.error)}`,
      exitCode: spawned.status,
      write: isWriteCall(subcommand, args),
    }
  }

  let output = `${spawned.stdout ?? ''}${(spawned.stderr ?? '') === '' ? '' : `\n${spawned.stderr ?? ''}`}`.trim()
  if (subcommand === 'diff' && output.length > DIFF_OUTPUT_LIMIT) {
    output = `${output.slice(0, DIFF_OUTPUT_LIMIT)}\n…（diff 超过 ${DIFF_OUTPUT_LIMIT} 字符已截断）`
  }
  if (BUDGETED_LINES.has(subcommand)) {
    const lines = output.split('\n')
    if (lines.length > STATUS_LINE_LIMIT) {
      output = `${lines.slice(0, STATUS_LINE_LIMIT).join('\n')}\n…（超过 ${STATUS_LINE_LIMIT} 行已截断）`
    }
  }
  const ok = spawned.status === 0
  const stderrTail = ok ? '' : `\n（exit ${String(spawned.status)}）`
  return {
    ok,
    output: `${output}${stderrTail}`.trim() || '（无输出）',
    exitCode: spawned.status,
    write: isWriteCall(subcommand, args),
  }
}
