/**
 * W1 接线验收：`magic_ceo` 存储域与 index.ts 的进程内 Map 是否真的打通。
 *
 * 两条命题，都指向同一件事 —— **重启后不靠事件回放猜状态**：
 *   1. 写：CEO 工具产生的状态，确实落进了 storageDomain 后端（用独立探针读同一后端）。
 *   2. 读：新实例优先从存储恢复（用 version 递增证明，且新实例的事件流是空的）。
 *
 * 运行：node --test plugins/magic-ceo/tests/ceo-store-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, resetCeoStateForTests } from '../src/index.ts'
import { createMemoryBacking, createMemoryPort, openCeoStore, type StorageDomainPort } from '../src/store/index.ts'

const SESSION = 'session-restart'

function journalSession(id: string) {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 4 } },
  ]
  return {
    id,
    events,
    snapshotEvents: () => events,
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: Date.now(), data }
      Object.freeze(event)
      events.push(event)
      return event
    },
  }
}

type ToolDef = {
  name: string
  execute: (
    args: unknown,
    exec: { agent?: unknown; callId?: string; signal: AbortSignal },
  ) => Promise<unknown>
}

/** 最小宿主：只需要 storageDomain + tools + systemPrompt + subagents。 */
function makeHost(
  storageDomain: StorageDomainPort,
  tools: Map<string, ToolDef>,
) {
  return {
    magicWorkMode: { getMode: () => 'ceo' as const },
    systemPrompt: { section: () => undefined },
    tools: { register: (definition: ToolDef) => { tools.set(definition.name, definition) } },
    subagents: {
      startContinuable: async () => ({ childId: 'unused' }),
      sendMessage: async () => 'unused',
    },
    storageDomain,
  }
}

/** openCeoStore 是 Promise 链，多放几个 microtask 再断言。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function callPlan(
  tools: Map<string, ToolDef>,
  session: ReturnType<typeof journalSession>,
  args: Record<string, unknown>,
  callId: string,
): Promise<void> {
  const tool = tools.get('ceo_plan')
  assert.ok(tool !== undefined, 'ceo_plan 应已注册')
  await tool.execute(args, { agent: { session }, callId, signal: new AbortController().signal })
}

test('接线·写：CEO 工具产生的状态确实落进 storageDomain 后端', async () => {
  resetCeoStateForTests()
  const backing = createMemoryBacking()
  const tools = new Map<string, ToolDef>()
  apply(makeHost(createMemoryPort(backing), tools) as never)
  await settle()

  await callPlan(
    tools,
    journalSession(SESSION),
    { tasks: [{ role: '国内市场', task: '调研' }], summary: '摘要', analysis: '分析' },
    'call-1',
  )
  await settle()

  // 用同一后端的**独立探针**读：能读到，就证明状态真的出了进程内存。
  const probe = await openCeoStore(createMemoryPort(backing))
  try {
    const stored = probe.getPlan(SESSION)
    assert.ok(stored !== undefined, '计划应落进 magic_ceo 域')
    assert.equal(stored?.summary, '摘要')
    assert.equal(stored?.version, 1)
  } finally {
    await probe.close()
  }
})

test('接线·读：新实例优先从存储恢复（version 递增，且事件流是空的）', async () => {
  resetCeoStateForTests()
  const backing = createMemoryBacking()

  // —— 第一个生命周期 ——
  const tools1 = new Map<string, ToolDef>()
  apply(makeHost(createMemoryPort(backing), tools1) as never)
  await settle()
  await callPlan(
    tools1,
    journalSession(SESSION),
    { tasks: [{ role: '国内市场', task: '调研' }], summary: '第一版', analysis: '分析' },
    'call-1',
  )
  await settle()

  // —— 模拟重启：清掉全部进程内存 ——
  resetCeoStateForTests()
  const tools2 = new Map<string, ToolDef>()
  apply(makeHost(createMemoryPort(backing), tools2) as never)
  await settle()

  // 全新 session 对象、全新事件流：回放拿不到任何东西，唯一来源是存储域。
  await callPlan(
    tools2,
    journalSession(SESSION),
    { tasks: [{ role: '海外市场', task: '调研' }], summary: '第二版', analysis: '分析' },
    'call-2',
  )
  await settle()

  const probe = await openCeoStore(createMemoryPort(backing))
  try {
    const stored = probe.getPlan(SESSION)
    // 同一 turn 的第二次计划：只有读到了上一世的 plan，version 才会递增为 2。
    assert.equal(stored?.version, 2, '应从存储域恢复上一版计划，而不是从 1 重来')
    assert.equal(stored?.summary, '第二版')
  } finally {
    await probe.close()
  }
})
