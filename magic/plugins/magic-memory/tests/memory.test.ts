/**
 * memory.ts 测试：CRUD + 作用域隔离 + 检索（内核 §6 / §7.2 W3 专属验收）。
 *
 * 用内存端口构造表，不加载真实 DSH。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMemoryPort, buildMemorySpec, magicDomain } from '../src/store.ts'
import { MemoryStore, MemoryNotFoundError } from '../src/memory.ts'
import type { MemoryRecord } from '../src/record.ts'

async function freshStore(): Promise<MemoryStore> {
  const spec = magicDomain(buildMemorySpec())
  const domain = await createMemoryPort().open(spec)
  return new MemoryStore(domain.table<MemoryRecord>('memories'))
}

test('add 后 get 能取回，且 id 稳定', async () => {
  const store = await freshStore()
  const record = await store.add({ layer: 'semantic', audience: 'member', content: '地球是圆的' })
  const back = store.get(record.id)
  assert.equal(back?.id, record.id)
  assert.equal(back?.content, '地球是圆的')
  assert.equal(store.list('member').length, 1)
})

test('update 改内容并刷新 updatedAt', async () => {
  const store = await freshStore()
  const record = await store.add({ layer: 'user', audience: 'member', content: '旧偏好' })
  const updated = await store.update(record.id, { content: '新偏好', tags: ['lang'] })
  assert.equal(updated.content, '新偏好')
  assert.equal(updated.updatedAt >= record.updatedAt, true)
  assert.deepEqual([...updated.tags], ['lang'])
})

test('update 不存在的记录抛错', async () => {
  const store = await freshStore()
  await assert.rejects(() => store.update('missing', { content: 'x' }), MemoryNotFoundError)
})

test('remove 返回是否存在，且删除后不可见', async () => {
  const store = await freshStore()
  const record = await store.add({ layer: 'episodic', audience: 'member', content: '一次对话' })
  assert.equal(await store.remove(record.id), true)
  assert.equal(await store.remove(record.id), false)
  assert.equal(store.get(record.id), undefined)
})

test('作用域隔离：member 看不到 ceo 私有记忆', async () => {
  const store = await freshStore()
  await store.add({ layer: 'rule', audience: 'ceo', content: 'CEO 私有规则：不与成员共享预算' })
  await store.add({ layer: 'rule', audience: 'member', content: '共享规则：先 plan 再 delegate' })

  const ceoView = store.list('ceo')
  const memberView = store.list('member')
  assert.equal(ceoView.length, 2)
  assert.equal(memberView.length, 1)
  assert.equal(memberView[0]?.audience, 'member')
  assert.ok(!memberView.some((r) => r.audience === 'ceo'))
})

test('作用域隔离（检索路径）：member 检索不到 ceo 私有', async () => {
  const store = await freshStore()
  await store.add({ layer: 'rule', audience: 'ceo', content: 'CEO 私有 memory secret' })
  await store.add({ layer: 'rule', audience: 'member', content: '共享 memory public' })

  const memberHits = store.search({ audience: 'member', query: 'memory' })
  assert.equal(memberHits.length, 1)
  assert.equal(memberHits[0]?.content, '共享 memory public')

  const ceoHits = store.search({ audience: 'ceo', query: 'memory' })
  assert.equal(ceoHits.length, 2)
})

test('检索按分层 / 标签 / 关键词过滤', async () => {
  const store = await freshStore()
  await store.add({ layer: 'semantic', audience: 'member', content: 'Tokyo 是日本首都', tags: ['geo'] })
  await store.add({ layer: 'user', audience: 'member', content: '用户偏好中文', tags: ['pref'] })
  await store.add({ layer: 'episodic', audience: 'member', content: '上周完成了迁移' })

  assert.equal(store.search({ audience: 'member', layer: 'semantic' }).length, 1)
  assert.equal(store.search({ audience: 'member', tags: ['pref'] }).length, 1)
  assert.equal(store.search({ audience: 'member', query: 'tokyo' }).length, 1)
  assert.equal(store.search({ audience: 'member', query: '日本' }).length, 1)
  assert.equal(store.search({ audience: 'member', query: '不存在' }).length, 0)
})

test('检索 limit 截断', async () => {
  const store = await freshStore()
  for (let i = 0; i < 5; i++) {
    await store.add({ layer: 'episodic', audience: 'member', content: `事件 ${i}` })
  }
  assert.equal(store.search({ audience: 'member', limit: 2 }).length, 2)
})

test('被否认（disputed）的记忆不出现在列表与检索中', async () => {
  const store = await freshStore()
  const record = await store.add({ layer: 'user', audience: 'member', content: '过时偏好' })
  await store.update(record.id, { disputed: true })
  assert.equal(store.list('member').length, 0)
  assert.equal(store.search({ audience: 'member', query: '过时' }).length, 0)
})

test('重复写入产生两条独立记录', async () => {
  const store = await freshStore()
  const a = await store.add({ layer: 'semantic', audience: 'member', content: '相同内容' })
  const b = await store.add({ layer: 'semantic', audience: 'member', content: '相同内容' })
  assert.notEqual(a.id, b.id)
  assert.equal(store.list('member').length, 2)
})

test('空记忆：list / search 返回空', async () => {
  const store = await freshStore()
  assert.deepEqual(store.list('member'), [])
  assert.deepEqual(store.search({ audience: 'ceo' }), [])
})
