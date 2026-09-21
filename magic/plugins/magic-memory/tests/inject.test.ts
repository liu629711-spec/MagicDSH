/**
 * inject.ts 测试：注入片段渲染、作用域过滤、超长截断（内核 §6：正常 + 边界）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderMemorySection, toSearchResult } from '../src/inject.ts'
import { makeMemoryRecord, type MemoryRecord } from '../src/record.ts'

function rec(layer: MemoryRecord['layer'], audience: MemoryRecord['audience'], content: string, tags: string[] = []): MemoryRecord {
  return makeMemoryRecord({ layer, audience, content, tags })
}

test('渲染按分层分组，rule 在最前', () => {
  const records = [
    rec('episodic', 'member', '事件A'),
    rec('rule', 'member', '规则B'),
    rec('user', 'member', '偏好C'),
  ]
  const out = renderMemorySection(records, { audience: 'member' })
  assert.ok(out.text.startsWith('【规则】'))
  assert.ok(out.text.includes('事件A'))
  assert.ok(out.text.includes('规则B'))
  assert.ok(out.text.includes('偏好C'))
})

test('作用域过滤：member 受众看不到 ceo 私有记忆', () => {
  const records = [
    rec('rule', 'ceo', 'CEO 私有'),
    rec('rule', 'member', '共享'),
  ]
  const memberOut = renderMemorySection(records, { audience: 'member' })
  assert.ok(!memberOut.text.includes('CEO 私有'))
  assert.ok(memberOut.text.includes('共享'))

  const ceoOut = renderMemorySection(records, { audience: 'ceo' })
  assert.ok(ceoOut.text.includes('CEO 私有'))
  assert.ok(ceoOut.text.includes('共享'))
})

test('被否认记忆不渲染', () => {
  const base = rec('user', 'member', '过时')
  const disputed: MemoryRecord = { ...base, disputed: true }
  const out = renderMemorySection([disputed], { audience: 'member' })
  assert.equal(out.count, 0)
})

test('单条超长正文被截断', () => {
  const long = 'x'.repeat(5000)
  const out = renderMemorySection([rec('semantic', 'member', long)], { audience: 'member', maxCharsPerRecord: 2000 })
  assert.ok(out.text.includes('（已截断）'))
  assert.ok(!out.text.includes('x'.repeat(5000)))
})

test('总字数上限触发截断并标记 truncated', () => {
  const records = Array.from({ length: 10 }, (_, i) => rec('episodic', 'member', `事件${i}`.repeat(200)))
  const out = renderMemorySection(records, { audience: 'member', maxTotalChars: 100, maxRecords: 50 })
  assert.equal(out.truncated, true)
  assert.ok(out.chars <= 100)
})

test('maxRecords 限制条数', () => {
  const records = Array.from({ length: 10 }, (_, i) => rec('episodic', 'member', `事件${i}`))
  const out = renderMemorySection(records, { audience: 'member', maxRecords: 3 })
  assert.equal(out.count, 3)
})

test('空记忆返回占位文本', () => {
  const out = renderMemorySection([], { audience: 'member' })
  assert.equal(out.count, 0)
  assert.equal(out.text, '(暂无可见记忆)')
})

test('toSearchResult 包装检索结果', () => {
  const records = [rec('user', 'member', '偏好')]
  const result = toSearchResult(records, 'member')
  assert.equal(result.audience, 'member')
  assert.equal(result.count, 1)
  assert.equal(result.records[0]?.content, '偏好')
})
