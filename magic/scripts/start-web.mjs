// Magic 实例启动器（web 面）。在产品仓根目录跑：
//
//   node magic/scripts/start-web.mjs                → headless agent browser
//   node magic/scripts/start-web.mjs --headed       → visible window (full fps)
//   其余参数原样转给 `dsh web`（如 --no-open --port 3097）
//
// 两片 patch 按顺序生效，都在本仓 magic/patches/ 下：
//   1) magic.patch.yml           官方能力开关 + 已迁入的产品插件
//   2) legacy-vendored.patch.yml 过渡：还没做能力对表的第三方/vendored 与 ceo-ui
// 第二片清空后即可删文件，届时这里只剩一片。
//
// 改过源码要重新构建才生效（两半分属两个 pass，见 magic/docs/底座边界.md §3）：
//   host   面  pnpm run build:lib:host
//   client 面  pnpm run build:lib:client   （或该包 pnpm run bundle）
//   前端壳     pnpm run build:web

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const headed = process.argv.includes('--headed')
const extra = process.argv.slice(2).filter((arg) => arg !== '--headed')

const patches = [
  join(repoRoot, 'magic', 'patches', 'magic.patch.yml'),
  join(repoRoot, 'magic', 'patches', 'legacy-vendored.patch.yml'),
]
// 运行态默认落在产品仓内，与迁移前那台 rc.2 实例（默认 home）分开：0.1.6 可能改写
// 会话文件格式，先不让两台同时写同一份历史。要吃旧历史用 DSH_HOME 指过去。
const home = process.env.DSH_HOME ?? join(repoRoot, '.magic-live')

const missing = patches.filter((file) => !existsSync(file))
if (missing.length > 0) {
  process.stderr.write(`[start-web] patch 文件不存在：\n${missing.map((f) => `  ${f}`).join('\n')}\n`)
  process.exit(1)
}

const env = {
  ...process.env,
  DSH_HOME: home,
  MAGIC_BROWSER_HEADLESS: headed ? '0' : '1',
}

const child = spawn(
  'pnpm',
  ['dsh', 'web', ...patches.flatMap((patch) => ['--patch', patch]), ...extra],
  { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32', env },
)

child.on('exit', (code) => (process.exitCode = code ?? 0))
