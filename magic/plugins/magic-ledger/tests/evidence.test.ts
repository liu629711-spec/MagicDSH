/**
 * 物证台账测试：落盘自报 + 读取 + 按 run 聚合 + 重复 id 幂等 + 契约同域。
 *
 * 运行：node --test plugins/magic-ledger/tests/evidence.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createMemoryPort,
  passthrough,
  type MagicDomain,
  type MagicDomainSpec,
} from '../src/store.ts'
import {
  recordEvidence,
  getEvidence,
  evidenceOfRun,
  latestEvidenceOfRun,
  recordContract,
  getContract,
  makeEvidenceId,
  type EvidenceRecord,
} from '../src/evidence.ts'

const LEDGER_SPEC: MagicDomainSpec = {
  name: 'magic_ledger',
  version: 1,
  layout: 'per-record',
  tables: {
    contracts: { valueSchema: passthrough<unknown>() },
    evidence: { valueSchema: passthrough<unknown>() },
  },
}

function openLedger(): Promise<MagicDomain> {
  return createMemoryPort().open(LEDGER_SPEC)
}

function sampleEvidence(id: string, runId: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id,
    runId,
    contractId: 'c1',
    recordedAt: '2026-09-11T00:00:00Z',
    landedPaths: ['out/report.md'],
    sectionsProduced: ['摘要', '结论'],
    citations: ['#r1'],
    ...over,
  }
}

// ── 读写 ──────────────────────────────────────────────────────────────────

test('recordEvidence + getEvidence round-trip', async () => {
  const domain = await openLedger()
  const rec = sampleEvidence('ev_1', 'run_a')
  await recordEvidence(domain, rec)
  assert.deepEqual(getEvidence(domain, 'ev_1'), rec)
  assert.equal(getEvidence(domain, 'missing'), undefined)
  await domain.close()
})

test('evidenceOfRun returns only the matching run, in order', async () => {
  const domain = await openLedger()
  await recordEvidence(domain, sampleEvidence('ev_1', 'run_a'))
  await recordEvidence(domain, sampleEvidence('ev_2', 'run_b', { landedPaths: [] }))
  await recordEvidence(domain, sampleEvidence('ev_3', 'run_a', { landedPaths: ['x.md'] }))

  const a = evidenceOfRun(domain, 'run_a')
  assert.deepEqual(a.map((e) => e.id), ['ev_1', 'ev_3'])
  assert.deepEqual(evidenceOfRun(domain, 'run_x'), [])
  assert.equal(latestEvidenceOfRun(domain, 'run_a')?.id, 'ev_3')
  await domain.close()
})

// ── 边界：重复记录幂等 ──────────────────────────────────────────────────────

test('recording the same evidence id overwrites (idempotent, size stays 1)', async () => {
  const domain = await openLedger()
  const table = domain.table<EvidenceRecord>('evidence')
  await recordEvidence(domain, sampleEvidence('ev_dup', 'run_a', { landedPaths: ['v1.md'] }))
  await recordEvidence(domain, sampleEvidence('ev_dup', 'run_a', { landedPaths: ['v2.md'] }))
  assert.equal(table.size, 1)
  assert.deepEqual(getEvidence(domain, 'ev_dup')?.landedPaths, ['v2.md'])
  await domain.close()
})

test('makeEvidenceId is stable for a given seq', () => {
  assert.equal(makeEvidenceId('run_a', 7), 'ev_run_a_7')
  assert.ok(makeEvidenceId('run_a').startsWith('ev_run_a_'))
})

// ── 契约同域 ────────────────────────────────────────────────────────────────

test('contracts table stores and reads back a contract', async () => {
  const domain = await openLedger()
  const contract = {
    form: 'files' as const,
    requiredSections: ['摘要'],
    outputFormat: 'json' as const,
    artifacts: ['report.md'],
    artifactDir: '',
    workspaceNative: false,
    citationMode: '' as const,
    strict: true,
  }
  await recordContract(domain, 'c1', contract)
  assert.deepEqual(getContract(domain, 'c1'), contract)
  assert.equal(getContract(domain, 'c2'), undefined)
  await domain.close()
})
