/**
 * W0 契约内核参考实现测试（内存端口 + schema 帮助函数 + 域校验）。
 *
 * 运行：node --test plugins/magic-ceo/tests/store.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createDshPort,
  createMemoryPort,
  magicDomain,
  passthrough,
  schema,
  DomainSpecError,
  StorageUnavailableError,
  type MagicDomainSpec,
} from '../src/store/index.ts'

const sampleSpec: MagicDomainSpec = {
  name: 'magic_ceo',
  version: 1,
  tables: {
    members: { valueSchema: passthrough<unknown>() },
    plans: { valueSchema: passthrough<unknown>() },
  },
}

// ── schema helpers ────────────────────────────────────────────────────────

test('schema() returns a validator whose parse is the given function', () => {
  const v = schema<number>((value) => {
    if (typeof value !== 'number') throw new Error('not a number')
    return value
  })
  assert.equal(v.parse(7), 7)
  assert.throws(() => v.parse('x'))
})

test('passthrough() accepts anything and asserts the type', () => {
  const v = passthrough<{ a: number }>()
  const value = { a: 1 }
  assert.equal(v.parse(value), value)
  assert.equal(v.parse(null), null)
})

// ── magicDomain() validation (mirrors DSH defineDomain, spec.ts:87-114) ───

test('magicDomain() accepts a well-formed spec', () => {
  assert.equal(magicDomain(sampleSpec), sampleSpec)
})

test('magicDomain() rejects a bad domain name', () => {
  assert.throws(
    () => magicDomain({ ...sampleSpec, name: 'Magic-Ceo' }),
    (error: unknown) => error instanceof DomainSpecError,
  )
})

test('magicDomain() rejects a negative or non-integer version', () => {
  assert.throws(() => magicDomain({ ...sampleSpec, version: -1 }), DomainSpecError)
  assert.throws(() => magicDomain({ ...sampleSpec, version: 1.5 }), DomainSpecError)
})

test('magicDomain() rejects an unknown layout', () => {
  assert.throws(
    () => magicDomain({ ...sampleSpec, layout: 'weird' as unknown as 'single' }),
    DomainSpecError,
  )
})

test('magicDomain() rejects a bad table name', () => {
  assert.throws(
    () => magicDomain({ name: 'magic_ceo', version: 1, tables: { BadTable: { valueSchema: passthrough() } } }),
    DomainSpecError,
  )
})

test('magicDomain() rejects a global schema that accepts null', () => {
  assert.throws(
    () => magicDomain({
      ...sampleSpec,
      global: { schema: passthrough<unknown>(), initial: { turn: 0 } },
    }),
    DomainSpecError,
  )
})

test('magicDomain() accepts a global schema that rejects null', () => {
  const globalSchema = schema<{ turn: number }>((value) => {
    if (value === null || typeof value !== 'object') throw new Error('bad global')
    return value as { turn: number }
  })
  const spec = magicDomain({
    ...sampleSpec,
    global: { schema: globalSchema as never, initial: { turn: 0 } },
  })
  assert.equal(spec.name, 'magic_ceo')
})

// ── memory port ───────────────────────────────────────────────────────────

test('memory port: put / get / update / delete round-trip', async () => {
  const port = createMemoryPort()
  const domain = await port.open(sampleSpec)
  const members = domain.table<{ role: string; turnSeq?: number }>('members')

  await members.put('a', { role: '国内市场' })
  assert.deepEqual(members.get('a'), { role: '国内市场' })
  assert.equal(members.get('missing'), undefined)
  assert.equal(members.size, 1)

  const updated = await members.update('a', (current) => ({ ...current, turnSeq: 2 }))
  assert.deepEqual(updated, { role: '国内市场', turnSeq: 2 })
  assert.deepEqual(members.get('a'), { role: '国内市场', turnSeq: 2 })

  assert.equal(await members.delete('a'), true)
  assert.equal(await members.delete('a'), false)
  assert.equal(members.size, 0)

  await domain.close()
})

test('memory port: entries()/keys() are snapshots, not live views', async () => {
  const port = createMemoryPort()
  const domain = await port.open(sampleSpec)
  const plans = domain.table<number>('plans')
  await plans.put('p1', 1)
  await plans.put('p2', 2)

  const keys = plans.keys()
  await plans.put('p3', 3)
  assert.deepEqual([...keys], ['p1', 'p2'])
  assert.deepEqual([...plans.entries()], [['p1', 1], ['p2', 2], ['p3', 3]])

  await domain.close()
})

test('memory port: update() on a missing key rejects', async () => {
  const port = createMemoryPort()
  const domain = await port.open(sampleSpec)
  await assert.rejects(() => domain.table('members').update('nope', (c) => c))
  await domain.close()
})

test('memory port: update() is serialized (no interleaving loss)', async () => {
  const port = createMemoryPort()
  const domain = await port.open(sampleSpec)
  const t = domain.table<{ n: number }>('plans')
  await t.put('k', { n: 0 })
  await Promise.all(
    Array.from({ length: 50 }, () => t.update('k', (c) => ({ n: c.n + 1 }))),
  )
  assert.deepEqual(t.get('k'), { n: 50 })
  await domain.close()
})

test('memory port: unknown table throws', async () => {
  const port = createMemoryPort()
  const domain = await port.open(sampleSpec)
  assert.throws(() => domain.table('nope'), /declares no table/)
  await domain.close()
})

test('memory port: single-open per domain name, name freed after close', async () => {
  const port = createMemoryPort()
  const first = await port.open(sampleSpec)
  await assert.rejects(() => port.open(sampleSpec), /already open/)
  await first.close()
  const second = await port.open(sampleSpec)
  assert.equal(second.name, 'magic_ceo')
  await second.close()
})

test('memory port: table access after close throws', async () => {
  const port = createMemoryPort()
  const domain = await port.open(sampleSpec)
  const t = domain.table('members')
  await domain.close()
  assert.throws(() => domain.table('members'), /is closed/)
  assert.throws(() => t.get('a'), /is closed/)
})

// ── DSH port guard ────────────────────────────────────────────────────────

test('createDshPort() throws a clear error when storageDomain is absent', () => {
  assert.throws(() => createDshPort({}), (error: unknown) => error instanceof StorageUnavailableError)
})

test('createDshPort() forwards open() to the host facility', async () => {
  const calls: MagicDomainSpec[] = []
  const fakeDomain = { name: 'magic_ceo', table: () => { throw new Error('unused') }, close: async () => {} }
  const port = createDshPort({
    storageDomain: {
      open: async (spec) => { calls.push(spec); return fakeDomain },
    },
  })
  const opened = await port.open(sampleSpec)
  assert.equal(opened.name, 'magic_ceo')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'magic_ceo')
})
