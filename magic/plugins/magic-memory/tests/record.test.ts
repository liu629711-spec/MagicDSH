/**
 * record.ts 测试：记忆记录构造与存储校验器（内核 §6：正常 + 边界 + 失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  makeMemoryRecord,
  recordSchema,
  RecordValidationError,
  type MemoryRecord,
} from '../src/record.ts'

test('makeMemoryRecord 生成带 id 与时间戳的完整记录', () => {
  const record = makeMemoryRecord({
    layer: 'episodic',
    audience: 'member',
    content: '用户偏好英文回复',
    tags: ['pref', 'lang'],
    source: 'session-1',
  })
  assert.equal(record.layer, 'episodic')
  assert.equal(record.audience, 'member')
  assert.equal(record.content, '用户偏好英文回复')
  assert.deepEqual([...record.tags], ['pref', 'lang'])
  assert.equal(record.source, 'session-1')
  assert.equal(record.disputed, false)
  assert.match(record.id, /^[0-9a-f-]{36}$/)
  assert.equal(typeof record.createdAt, 'string')
  assert.equal(record.updatedAt, record.createdAt)
})

test('makeMemoryRecord 缺省 tags/source 时回退空值', () => {
  const record = makeMemoryRecord({ layer: 'rule', audience: 'ceo', content: '先 plan 再 delegate' })
  assert.deepEqual([...record.tags], [])
  assert.equal(record.source, '')
})

test('makeMemoryRecord 拒绝非法分层', () => {
  assert.throws(
    () => makeMemoryRecord({ layer: 'bogus' as never, audience: 'member', content: 'x' }),
    RecordValidationError,
  )
})

test('makeMemoryRecord 拒绝非法受众', () => {
  assert.throws(
    () => makeMemoryRecord({ layer: 'user', audience: 'admin' as never, content: 'x' }),
    RecordValidationError,
  )
})

test('makeMemoryRecord 拒绝空正文', () => {
  assert.throws(
    () => makeMemoryRecord({ layer: 'user', audience: 'member', content: '   ' }),
    RecordValidationError,
  )
})

test('recordSchema.parse 接受合法落盘对象并归一化', () => {
  const parsed = recordSchema().parse({
    id: 'abc',
    layer: 'semantic',
    audience: 'member',
    content: 'Tokyo 是日本首都',
    tags: ['geo'],
    source: 's',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
  assert.equal(parsed.id, 'abc')
  assert.equal(parsed.disputed, false)
})

test('recordSchema.parse 把 disputed 真值归一化、非数组 tags 回退空', () => {
  const parsed = recordSchema().parse({
    id: 'abc',
    layer: 'user',
    audience: 'ceo',
    content: 'x',
    tags: 'not-array',
    createdAt: 't',
    updatedAt: 't',
    disputed: true,
  }) as MemoryRecord
  assert.equal(parsed.disputed, true)
  assert.deepEqual([...parsed.tags], [])
})

test('recordSchema.parse 拒绝缺 id / 非法分层 / 空正文', () => {
  assert.throws(() => recordSchema().parse({ layer: 'user', audience: 'member', content: 'x' }), RecordValidationError)
  assert.throws(
    () => recordSchema().parse({ id: 'a', layer: 'nope', audience: 'member', content: 'x', createdAt: 't', updatedAt: 't' }),
    RecordValidationError,
  )
  assert.throws(
    () => recordSchema().parse({ id: 'a', layer: 'user', audience: 'member', content: '', createdAt: 't', updatedAt: 't' }),
    RecordValidationError,
  )
})

test('recordSchema.parse 拒绝非对象', () => {
  assert.throws(() => recordSchema().parse(null), RecordValidationError)
  assert.throws(() => recordSchema().parse(42), RecordValidationError)
})
