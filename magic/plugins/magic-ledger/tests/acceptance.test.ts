/**
 * 验收判定测试：正常路径 + 边界（空契约 / 缺章节 / 产物未落盘 / 重复物证）+ 失败路径。
 * 末尾用 apply 跑一遍端到端（注入内存端口），验证 index.ts 入口。
 *
 * 运行：node --test plugins/magic-ledger/tests/acceptance.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeContract,
  type DeliveryContract,
} from '../src/contract.ts'
import { makeEvidenceId, type EvidenceRecord } from '../src/evidence.ts'
import {
  verifyDelivery,
  landedMatchesDeclared,
  type GroundTruth,
} from '../src/acceptance.ts'
import { apply, name, inject } from '../src/index.ts'
import { createMemoryPort, passthrough, type MagicDomain, type MagicDomainSpec } from '../src/store.ts'

const LEDGER_SPEC: MagicDomainSpec = {
  name: 'magic_ledger',
  version: 1,
  layout: 'per-record',
  tables: {
    contracts: { valueSchema: passthrough<unknown>() },
    evidence: { valueSchema: passthrough<unknown>() },
  },
}

function filesContract(over: Partial<DeliveryContract> = {}): DeliveryContract {
  return {
    form: 'files',
    requiredSections: ['摘要', '结论'],
    outputFormat: 'json',
    artifacts: ['out/report.md'],
    artifactDir: '',
    workspaceNative: false,
    citationMode: '',
    strict: true,
    ...over,
  }
}

function evidence(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: makeEvidenceId('run_a'),
    runId: 'run_a',
    contractId: 'c1',
    recordedAt: '2026-09-11T00:00:00Z',
    landedPaths: ['out/report.md'],
    sectionsProduced: ['摘要', '结论'],
    citations: [],
    ...over,
  }
}

// ── 路径匹配（对齐 AgentCore landed_matches_declared） ──────────────────────

test('landedMatchesDeclared: exact / dir / glob', () => {
  assert.equal(landedMatchesDeclared(['out/report.md'], 'out/report.md'), true)
  assert.equal(landedMatchesDeclared(['out/report.md'], 'other.md'), false)
  assert.equal(landedMatchesDeclared(['out/deep/x.md'], 'out/'), true)
  assert.equal(landedMatchesDeclared(['out/x.md'], 'out/*.md'), true)
  assert.equal(landedMatchesDeclared(['out/x.txt'], 'out/*.md'), false)
})

// ── 正常路径 ────────────────────────────────────────────────────────────────

test('satisfied when files contract fully met by evidence + real landing', () => {
  const verdict = verifyDelivery(
    filesContract(),
    evidence(),
    { landedPaths: ['out/report.md'], verifiedCitationIds: [] },
  )
  assert.equal(verdict.contractValid, true)
  assert.equal(verdict.satisfied, true)
  assert.deepEqual(verdict.missingSections, [])
  assert.deepEqual(verdict.missingArtifacts, [])
  assert.equal(verdict.artifactsChecked, true)
})

// ── 边界：空契约 ──────────────────────────────────────────────────────────────

test('empty contract (prose, no sections) is trivially satisfied', () => {
  const verdict = verifyDelivery(
    normalizeContract(undefined),
    evidence({ sectionsProduced: [], landedPaths: [] }),
    { landedPaths: [], verifiedCitationIds: [] },
  )
  assert.equal(verdict.contractValid, true)
  assert.equal(verdict.satisfied, true)
  assert.equal(verdict.artifactsChecked, false)
})

// ── 边界：缺章节 ──────────────────────────────────────────────────────────────

test('missing required sections are reported and break satisfaction', () => {
  const verdict = verifyDelivery(
    filesContract({ requiredSections: ['摘要', '方法', '结论'] }),
    evidence({ sectionsProduced: ['摘要'] }),
    { landedPaths: ['out/report.md'], verifiedCitationIds: [] },
  )
  assert.deepEqual(verdict.missingSections, ['方法', '结论'])
  assert.equal(verdict.satisfied, false)
})

// ── 边界：产物未落盘 ──────────────────────────────────────────────────────────

test('declared artifact not on disk is missing and breaks satisfaction', () => {
  const verdict = verifyDelivery(
    filesContract(),
    evidence(),
    { landedPaths: [], verifiedCitationIds: [] },
  )
  assert.deepEqual(verdict.missingArtifacts, ['out/report.md'])
  assert.equal(verdict.satisfied, false)
})

test('prose form skips artifact landing check entirely', () => {
  const verdict = verifyDelivery(
    normalizeContract({ form: 'prose', required_sections: ['摘要'] }),
    evidence({ sectionsProduced: ['摘要'], landedPaths: [] }),
    { landedPaths: [], verifiedCitationIds: [] },
  )
  assert.equal(verdict.artifactsChecked, false)
  assert.deepEqual(verdict.missingArtifacts, [])
  assert.equal(verdict.satisfied, true)
})

// ── 失败路径：引用不合规 ──────────────────────────────────────────────────────

test('two_phase with unverified citation is not compliant', () => {
  const verdict = verifyDelivery(
    filesContract({ citationMode: 'two_phase' }),
    evidence({ citations: ['#r1', '#r2'] }),
    { landedPaths: ['out/report.md'], verifiedCitationIds: ['#r1'] },
  )
  assert.equal(verdict.citationCompliant, false)
  assert.deepEqual(verdict.citationIssues, ['citation #r2 is not in the verified set'])
  assert.equal(verdict.satisfied, false)
})

test('two_phase with no citations reported is not compliant', () => {
  const verdict = verifyDelivery(
    filesContract({ citationMode: 'two_phase' }),
    evidence({ citations: [] }),
    { landedPaths: ['out/report.md'], verifiedCitationIds: ['#r1'] },
  )
  assert.equal(verdict.citationCompliant, false)
})

test('two_phase passes when all citations are verified', () => {
  const verdict = verifyDelivery(
    filesContract({ citationMode: 'two_phase', requiredSections: [] }),
    evidence({ citations: ['#r1'], sectionsProduced: [] }),
    { landedPaths: ['out/report.md'], verifiedCitationIds: ['#r1', '#r2'] },
  )
  assert.equal(verdict.citationCompliant, true)
  assert.equal(verdict.satisfied, true)
})

// ── 失败路径：非法契约 ──────────────────────────────────────────────────────────

test('invalid contract (bad enum) makes contractValid false and never satisfied', () => {
  const bad = filesContract()
  // 强制注入非法枚举值（仅测试用；归一化会回落，这里直接构造越界）
  ;(bad as { form: string }).form = 'video'
  const verdict = verifyDelivery(bad, evidence(), { landedPaths: ['out/report.md'], verifiedCitationIds: [] })
  assert.equal(verdict.contractValid, false)
  assert.equal(verdict.satisfied, false)
})

// ── 端到端：apply 注册工具并用内存端口验收 ────────────────────────────────────

test('apply() opens the domain, registers tools, and verifies end-to-end via memory port', async () => {
  assert.equal(name, 'magic-ledger')
  assert.deepEqual(inject, ['tools', 'storageDomain'])

  const registered: Record<string, { execute: (args: unknown) => unknown }> = {}
  const emitted: Array<{ event: string; payload: unknown }> = []
  const port = createMemoryPort()

  const ctx = {
    tools: {
      register: (tool: { name: string; execute: (args: unknown) => unknown }) => {
        registered[tool.name] = tool
      },
    },
    storageDomain: port,
    effect: () => {},
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload })
    },
  }
  await apply(ctx)

  assert.ok(registered['ledger_record_evidence'] !== undefined)
  assert.ok(registered['ledger_verify'] !== undefined)

  await registered['ledger_record_evidence'].execute({
    run_id: 'run_e2e',
    contract_id: 'c_e2e',
    contract: { form: 'files', required_sections: ['摘要', '结论'], artifacts: ['out/report.md'] },
    landed_paths: ['out/report.md'],
    sections_produced: ['摘要', '结论'],
    citations: ['#r1'],
  })
  assert.ok(emitted.some((e) => e.event === 'magic:ledger:evidence-recorded'))

  const verdict = (await registered['ledger_verify'].execute({
    run_id: 'run_e2e',
    contract_id: 'c_e2e',
    landed_paths: ['out/report.md'],
    verified_citation_ids: ['#r1'],
  })) as { satisfied: boolean; missingSections: string[]; missingArtifacts: string[] }

  assert.equal(verdict.satisfied, true)
  assert.deepEqual(verdict.missingSections, [])
  assert.deepEqual(verdict.missingArtifacts, [])

  // 第二次 verify 用同一份物证，但产物未落盘 → 应判不满足（基于事实，不基于自述）
  const failed = (await registered['ledger_verify'].execute({
    run_id: 'run_e2e',
    contract_id: 'c_e2e',
    landed_paths: [],
    verified_citation_ids: ['#r1'],
  })) as { satisfied: boolean; missingArtifacts: string[] }
  assert.equal(failed.satisfied, false)
  assert.deepEqual(failed.missingArtifacts, ['out/report.md'])
})

test('tool boundary rejects non-path-safe ids with an actionable error', async () => {
  const registered: Record<string, { execute: (args: unknown) => unknown }> = {}
  const ctx = {
    tools: {
      register: (tool: { name: string; execute: (args: unknown) => unknown }) => {
        registered[tool.name] = tool
      },
    },
    storageDomain: createMemoryPort(),
    effect: () => {},
    emit: () => {},
  }
  await apply(ctx)

  // 中文 run_id 会成为 storage-json 的落盘 key 而被官方拒绝（path-safe 约束），
  // 账本必须在工具边界就给出可读报错，而不是等落盘时抛天书异常。
  await assert.rejects(
    () => Promise.resolve(registered['ledger_record_evidence']!.execute({ run_id: 'del_1_计算员' })),
    /path-safe/,
  )
  await assert.rejects(
    () => Promise.resolve(registered['ledger_verify']!.execute({
      run_id: 'del_1_计算员',
      contract: { form: 'prose', required_sections: ['结论'] },
      landed_paths: [],
      verified_citation_ids: [],
    })),
    /path-safe/,
  )
  // ASCII id 正常落盘
  await registered['ledger_record_evidence']!.execute({ run_id: 'del_1_ji-suan-yuan' })
})
