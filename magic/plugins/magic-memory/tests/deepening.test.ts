/**
 * 记忆深化测试：主题巩固、维护清扫、作用域链。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMemoryPort, buildMemorySpec, magicDomain } from '../src/store.ts'
import { MemoryStore } from '../src/memory.ts'
import { consolidateTopic, listTopicNotes, maintain, topicTagOf } from '../src/topics.ts'
import { visibleAudiencesOf, isVisibleOnChain } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record.ts'

async function freshStore(): Promise<MemoryStore> {
  const spec = magicDomain(buildMemorySpec())
  const domain = await createMemoryPort().open(spec)
  return new MemoryStore(domain.table<MemoryRecord>('memories'))
}

test('作用域链：ceo 可见 ceo+member，member 只见 member', () => {
  assert.deepEqual([...visibleAudiencesOf('ceo')], ['ceo', 'member'])
  assert.deepEqual([...visibleAudiencesOf('member')], ['member'])
  assert.equal(isVisibleOnChain('ceo', 'member'), false)
  assert.equal(isVisibleOnChain('member', 'ceo'), true)
})

test('巩固：同主题零散记录合并为一条主题笔记，源记录打 consolidated', async () => {
  const store = await freshStore()
  await store.add({ layer: 'episodic', audience: 'member', content: '用户官网主色是深蓝', tags: ['topic:官网'], source: 'run-a' })
  await store.add({ layer: 'episodic', audience: 'member', content: '官网部署在 Vercel', tags: ['topic:官网'], source: 'run-b' })

  const result = await consolidateTopic(store, 'member', '官网')
  assert.equal(result.updated, false)
  assert.equal(result.sourceIds.length, 2)
  assert.ok(result.note.tags.includes('topic:官网'))
  assert.ok(result.note.tags.includes('note'))
  assert.match(result.note.content, /深蓝/)
  assert.match(result.note.content, /Vercel/)

  // 源记录被标记 consolidated
  for (const id of result.sourceIds) {
    assert.ok(store.get(id)?.tags.includes('consolidated'))
  }

  // 幂等：再次巩固更新同一条笔记，不新建
  await store.add({ layer: 'episodic', audience: 'member', content: '官网域名已备案', tags: ['topic:官网'], source: 'run-c' })
  const again = await consolidateTopic(store, 'member', '官网')
  assert.equal(again.updated, true)
  assert.equal(again.note.id, result.note.id)
  assert.match(again.note.content, /已备案/)

  // 目录来源：主题笔记可列出
  const topics = listTopicNotes(store, 'member')
  assert.equal(topics.length, 1)
  assert.ok(topics[0]?.tags.includes('topic:官网'))
})

test('巩固：无可巩固记录时抛可读错误', async () => {
  const store = await freshStore()
  await assert.rejects(() => consolidateTopic(store, 'member', '不存在的主题'), /没有可巩固的记录/)
})

test('巩固：ceo 私有主题不会混进 member 巩固结果', async () => {
  const store = await freshStore()
  await store.add({ layer: 'episodic', audience: 'ceo', content: 'CEO 私有：预算上限', tags: ['topic:预算'] })
  // member 受众看不见 ceo 私有记录 ⇒ 可巩固集合为空 ⇒ 抛错而不是固化私有内容
  await assert.rejects(() => consolidateTopic(store, 'member', '预算'), /没有可巩固的记录/)
  // ceo 自己可以巩固
  const result = await consolidateTopic(store, 'ceo', '预算')
  assert.equal(result.sourceIds.length, 1)
})

test('维护：过期争议记录被清扫，统计正确', async () => {
  const store = await freshStore()
  await store.add({ layer: 'episodic', audience: 'member', content: '好记忆' })
  const bad = await store.add({ layer: 'episodic', audience: 'member', content: '被否认的旧记忆' })
  await store.update(bad.id, { disputed: true })
  // 把 updatedAt 拨回 40 天前（直接写表绕过 update 的刷新语义）
  const stale = store.get(bad.id)
  assert.ok(stale !== undefined)
  const table = (store as unknown as { table: { update: (id: string, fn: (r: MemoryRecord) => MemoryRecord) => Promise<MemoryRecord> } }).table
  await table.update(bad.id, (current) => ({ ...current, updatedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString() }))

  const report = await maintain(store, 'member', 30)
  assert.equal(report.purgedDisputed, 1)
  assert.equal(store.get(bad.id), undefined)
  assert.equal(report.total, 1)
  assert.equal(report.countsByLayer.episodic, 1)
  assert.ok(topicTagOf('x').startsWith('topic:'))
})
