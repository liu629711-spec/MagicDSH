/**
 * W1 首增量测试：magic_ceo 域持久化 + **重启恢复**。
 *
 * 运行：node --test plugins/magic-ceo/tests/ceo-store.test.ts
 *
 * 核心命题：进程内存 → 存储域之后，**销毁实例再用同一后端重建，状态必须完整还原**。
 * 这正是现在最脆的地方（6 个模块级 Map，崩溃即失忆）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CEO_DOMAIN_NAME,
  CEO_DOMAIN_VERSION,
  ceoDomainSpec,
  createMemoryBacking,
  createMemoryPort,
  openCeoStore,
  type PersistedMember,
} from '../src/store/index.ts'

function member(parentSessionId: string, runId: string, extra: Partial<PersistedMember> = {}): PersistedMember {
  return {
    runId,
    rawId: runId,
    memberId: `${runId}-child`,
    parentSessionId,
    role: runId,
    task: `任务 ${runId}`,
    dependsOn: [],
    phase: 'queued',
    createdAt: '2026-09-11T00:00:00.000Z',
    ...extra,
  }
}

test('ceoDomainSpec() 名称与版本符合内核约定', () => {
  const spec = ceoDomainSpec()
  assert.equal(spec.name, CEO_DOMAIN_NAME)
  assert.equal(spec.name, 'magic_ceo')
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/)
  assert.equal(spec.version, CEO_DOMAIN_VERSION)
  assert.equal(spec.layout, 'single')
  assert.deepEqual(Object.keys(spec.tables).sort(), ['channels', 'members', 'plans', 'usage'])
})

test('members：写入 / 读取 / 按 parent 过滤 / 删除', async () => {
  const port = createMemoryPort()
  const store = await openCeoStore(port)
  try {
    await store.putMember(member('s1', 'a'))
    await store.putMember(member('s1', 'b'))
    await store.putMember(member('s2', 'a'))

    assert.equal(store.getMember('s1', 'a')?.role, 'a')
    assert.equal(store.getMember('s1', 'nope'), undefined)
    assert.deepEqual(store.membersOf('s1').map(m => m.runId).sort(), ['a', 'b'])
    assert.deepEqual(store.membersOf('s2').map(m => m.runId), ['a'])

    assert.equal(await store.removeMember('s1', 'a'), true)
    assert.equal(await store.removeMember('s1', 'a'), false)
    assert.deepEqual(store.membersOf('s1').map(m => m.runId), ['b'])
  } finally {
    await store.close()
  }
})

test('plans：写入 / 读取 / 深拷贝隔离', async () => {
  const port = createMemoryPort()
  const store = await openCeoStore(port)
  try {
    const plan = {
      turn: 3,
      planId: 'p-1',
      version: 2,
      summary: '摘要',
      analysis: '分析',
      tasks: [{ id: 't1', role: '国内市场', task: '调研', dependsOn: [] }],
    }
    await store.putPlan('s1', plan)
    // 调用方改了入参，存储里的副本不应受影响
    plan.tasks[0]!.task = '被改坏了'
    const stored = store.getPlan('s1')
    assert.equal(stored?.tasks[0]?.task, '调研')
    assert.equal(store.getPlan('missing'), undefined)
  } finally {
    await store.close()
  }
})

test('usage：累加不丢增量（并发安全）', async () => {
  const port = createMemoryPort()
  const store = await openCeoStore(port)
  try {
    const delta = { inputTokens: 10, outputTokens: 1 }
    await Promise.all(
      Array.from({ length: 20 }, () => store.addUsage('s1', 'm1', delta)),
    )
    const usage = store.usageOf('s1').get('m1')
    assert.equal(usage?.inputTokens, 200)
    assert.equal(usage?.outputTokens, 20)
  } finally {
    await store.close()
  }
})

test('usage：可选 token 字段只在提供时累加', async () => {
  const port = createMemoryPort()
  const store = await openCeoStore(port)
  try {
    await store.addUsage('s1', 'm1', { inputTokens: 1, outputTokens: 1, reasoningTokens: 5 })
    await store.addUsage('s1', 'm1', { inputTokens: 1, outputTokens: 1 })
    const usage = store.usageOf('s1').get('m1')
    assert.equal(usage?.reasoningTokens, 5)
    assert.equal(usage?.inputTokens, 2)
    assert.equal(usage?.totalTokens, undefined)
  } finally {
    await store.close()
  }
})

test('channels：写入 / 读取 / 未写入返回空数组', async () => {
  const port = createMemoryPort()
  const store = await openCeoStore(port)
  try {
    await store.putChannels('s1', 'm1', [{ channel: 'skill', chars: 100, truncated: false }])
    assert.deepEqual(store.channelsOf('s1', 'm1'), [{ channel: 'skill', chars: 100, truncated: false }])
    assert.deepEqual(store.channelsOf('s1', 'nope'), [])
  } finally {
    await store.close()
  }
})

test('parentSessions() 汇总所有父会话', async () => {
  const port = createMemoryPort()
  const store = await openCeoStore(port)
  try {
    await store.putMember(member('s1', 'a'))
    await store.addUsage('s2', 'm', { inputTokens: 1, outputTokens: 1 })
    await store.putPlan('s3', { turn: 1, planId: 'p', version: 1, summary: '', analysis: '', tasks: [] })
    assert.deepEqual(store.parentSessions().sort(), ['s1', 's2', 's3'])
  } finally {
    await store.close()
  }
})

// ── 核心：重启恢复 ────────────────────────────────────────────────────────

test('重启恢复：关闭后用同一后端重建，全部状态完整还原', async () => {
  const backing = createMemoryBacking()

  // —— 第一次"进程生命周期" ——
  const port1 = createMemoryPort(backing)
  const store1 = await openCeoStore(port1)
  await store1.putMember(member('s1', '国内市场', { phase: 'completed', turnSeq: 2 }))
  await store1.putMember(member('s1', '海外市场', { phase: 'running' }))
  await store1.putPlan('s1', {
    turn: 2,
    planId: 'p-1',
    version: 1,
    summary: '两路并行调研',
    analysis: '...',
    teamBrief: '共享上下文',
    tasks: [
      { id: 't1', role: '国内市场', task: '调研国内', dependsOn: [] },
      { id: 't2', role: '海外市场', task: '调研海外', dependsOn: ['t1'] },
    ],
  })
  await store1.addUsage('s1', '国内市场', { inputTokens: 100, outputTokens: 20 })
  await store1.putChannels('s1', '海外市场', [{ channel: 'memory', chars: 42, truncated: true }])
  await store1.close()

  // —— 模拟进程重启：同一后端，全新端口 ——
  const port2 = createMemoryPort(backing)
  const store2 = await openCeoStore(port2)
  try {
    const members = store2.membersOf('s1').sort((a, b) => a.runId.localeCompare(b.runId))
    assert.equal(members.length, 2)
    assert.equal(members[0]?.runId, '国内市场')
    assert.equal(members[0]?.phase, 'completed')
    assert.equal(members[0]?.turnSeq, 2)
    assert.equal(members[1]?.phase, 'running')

    const plan = store2.getPlan('s1')
    assert.equal(plan?.summary, '两路并行调研')
    assert.equal(plan?.teamBrief, '共享上下文')
    assert.deepEqual(plan?.tasks[1]?.dependsOn, ['t1'])

    assert.deepEqual(store2.usageOf('s1').get('国内市场'), { inputTokens: 100, outputTokens: 20 })
    assert.deepEqual(store2.channelsOf('s1', '海外市场'), [{ channel: 'memory', chars: 42, truncated: true }])

    // 跨重启继续累加，不重置
    await store2.addUsage('s1', '国内市场', { inputTokens: 5, outputTokens: 1 })
    assert.equal(store2.usageOf('s1').get('国内市场')?.inputTokens, 105)

    // 写入的成员可被再次删除（持久态的删除也要跨重启一致）
    assert.equal(await store2.removeMember('s1', '海外市场'), true)
    assert.equal(store2.getMember('s1', '海外市场'), undefined)
  } finally {
    await store2.close()
  }
})

test('不同后端互不串数据（隔离性）', async () => {
  const storeA = await openCeoStore(createMemoryPort(createMemoryBacking()))
  const storeB = await openCeoStore(createMemoryPort(createMemoryBacking()))
  try {
    await storeA.putMember(member('s1', 'only-in-A'))
    assert.equal(storeA.membersOf('s1').length, 1)
    assert.equal(storeB.membersOf('s1').length, 0)
  } finally {
    await storeA.close()
    await storeB.close()
  }
})

test('同一端口重复 open 同域被拒（单域名单次 open）', async () => {
  const port = createMemoryPort()
  const store = await openCeoStore(port)
  await assert.rejects(() => openCeoStore(port), /already open/)
  await store.close()
  // 关闭后释放，可再次 open
  const again = await openCeoStore(port)
  await again.close()
})
