/**
 * 交付契约测试：归一化默认值 + 校验（良构 / 非法枚举 / 语义 warning）。
 *
 * 运行：node --test plugins/magic-ledger/tests/contract.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeContract,
  validateContract,
  parseContract,
  DELIVERY_FORMS,
  OUTPUT_FORMATS,
  CITATION_MODES,
  type DeliveryContract,
} from '../src/contract.ts'

// ── 归一化默认值 ──────────────────────────────────────────────────────────

test('normalizeContract falls back to safe defaults on empty input', () => {
  const c = normalizeContract(undefined)
  assert.equal(c.form, 'prose')
  assert.equal(c.outputFormat, 'text')
  assert.equal(c.citationMode, '')
  assert.equal(c.strict, false)
  assert.equal(c.workspaceNative, false)
  assert.deepEqual(c.requiredSections, [])
  assert.deepEqual(c.artifacts, [])
  assert.equal(c.artifactDir, '')
})

test('normalizeContract keeps declared values and coerces types', () => {
  const c = normalizeContract({
    form: 'files',
    output_format: 'json',
    citation_mode: 'two_phase',
    strict: true,
    workspace_native: true,
    required_sections: ['摘要', '方法', 42, '', '结论'],
    artifacts: ['a.md', null, 'b/'],
    artifact_dir: 'out/',
  })
  assert.equal(c.form, 'files')
  assert.equal(c.outputFormat, 'json')
  assert.equal(c.citationMode, 'two_phase')
  assert.equal(c.strict, true)
  assert.equal(c.workspaceNative, true)
  // 非字符串与空串被剥离
  assert.deepEqual(c.requiredSections, ['摘要', '方法', '结论'])
  assert.deepEqual(c.artifacts, ['a.md', 'b/'])
  assert.equal(c.artifactDir, 'out/')
})

test('normalizeContract accepts unknown form as prose (safe default)', () => {
  const c = normalizeContract({ form: 'weird' })
  assert.equal(c.form, 'prose')
})

// ── 校验 ──────────────────────────────────────────────────────────────────

test('validateContract accepts a well-formed files contract', () => {
  const c: DeliveryContract = {
    form: 'files',
    requiredSections: ['摘要'],
    outputFormat: 'json',
    artifacts: ['report.md'],
    artifactDir: '',
    workspaceNative: true,
    citationMode: '',
    strict: true,
  }
  assert.deepEqual(validateContract(c), [])
})

test('validateContract rejects bad enum values', () => {
  const badForm = validateContract({ ...baseContract(), form: 'video' as never })
  assert.ok(badForm.some((i) => i.level === 'error' && i.field === 'form'))

  const badOut = validateContract({ ...baseContract(), outputFormat: 'yaml' as never })
  assert.ok(badOut.some((i) => i.level === 'error' && i.field === 'output_format'))

  const badCite = validateContract({ ...baseContract(), citationMode: 'three_phase' as never })
  assert.ok(badCite.some((i) => i.level === 'error' && i.field === 'citation_mode'))
})

test('validateContract warns (not errors) on files form without landing constraint', () => {
  const issues = validateContract({ ...baseContract(), form: 'files', artifacts: [], artifactDir: '' })
  const warn = issues.find((i) => i.field === 'artifacts')
  assert.ok(warn !== undefined)
  assert.equal(warn?.level, 'warning')
  // warning 不阻断 contractValid
  assert.ok(!issues.some((i) => i.level === 'error'))
})

test('parseContract returns contract + issues together', () => {
  const { contract, issues } = parseContract({ form: 'files', artifacts: ['x.md'] })
  assert.equal(contract.form, 'files')
  assert.deepEqual(issues, [])
})

test('enum constants cover the source schema', () => {
  assert.deepEqual([...DELIVERY_FORMS], ['prose', 'files'])
  assert.deepEqual([...OUTPUT_FORMATS], ['text', 'json'])
  assert.deepEqual([...CITATION_MODES], ['two_phase', ''])
})

function baseContract(): DeliveryContract {
  return {
    form: 'prose',
    requiredSections: [],
    outputFormat: 'text',
    artifacts: [],
    artifactDir: '',
    workspaceNative: false,
    citationMode: '',
    strict: false,
  }
}
