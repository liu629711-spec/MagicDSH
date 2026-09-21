/**
 * 物证验收规则（纯函数层）。
 *
 * 核心命题：**账本物证可以推翻"自述达标"，但不能凭空制造达标，也不能把已经承认的失败改好。**
 * 另一条同样重要的边界：**"无法核对"不等于"不达标"** —— files 形态契约在没有真实落盘事实时
 * 不参与否决，否则开了契约会让所有交付集体误伤。
 *
 * 运行：node --test plugins/magic-ceo/tests/ceo-evidence.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyEvidenceVerdict, contractBrief, DEFAULT_DELIVERY_CONTRACT, evidenceRejection, type EvidenceVerdictView } from '../src/delivery.ts'

function verdict(over: Partial<EvidenceVerdictView> = {}): EvidenceVerdictView {
  return {
    contractValid: true,
    satisfied: true,
    missingSections: [],
    missingArtifacts: [],
    citationCompliant: true,
    citationIssues: [],
    ...over,
  }
}

const COMPLETED = { phase: 'completed' as const, status: 'completed' as const }

test('物证满足契约时，自述达标保持不变', () => {
  const result = applyEvidenceVerdict(COMPLETED, verdict(), false)
  assert.equal(result.status, 'completed')
  assert.equal(result.phase, 'completed')
  assert.equal(result.error, undefined)
})

test('物证缺失必需章节时，把"自述达标"打成不达标', () => {
  const result = applyEvidenceVerdict(COMPLETED, verdict({ satisfied: false, missingSections: ['风险', '结论'] }), false)
  assert.equal(result.phase, 'unverified')
  assert.equal(result.status, 'unverified')
  assert.match(result.error ?? '', /风险/)
  assert.match(result.error ?? '', /结论/)
})

test('无契约（verdict 为 undefined）时完全不改变结论', () => {
  const result = applyEvidenceVerdict(COMPLETED, undefined, false)
  assert.equal(result.status, 'completed')
  assert.equal(result.error, undefined)
})

test('物证不能把已经承认的失败/部分完成改好', () => {
  const failed = applyEvidenceVerdict({ phase: 'failed', status: 'failed', error: 'worker declared failure' }, verdict(), false)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'worker declared failure')

  const partial = applyEvidenceVerdict({ phase: 'completed', status: 'partial' }, verdict(), false)
  assert.equal(partial.status, 'partial')
})

test('契约本身不合法时视为不达标', () => {
  const result = applyEvidenceVerdict(COMPLETED, verdict({ contractValid: false, satisfied: false }), false)
  assert.equal(result.status, 'unverified')
  assert.match(result.error ?? '', /malformed/)
})

test('引用不合规时视为不达标，并带上具体理由', () => {
  const result = applyEvidenceVerdict(
    COMPLETED,
    verdict({ satisfied: false, citationCompliant: false, citationIssues: ['citation c7 is not in the verified set'] }),
    false,
  )
  assert.equal(result.status, 'unverified')
  assert.match(result.error ?? '', /c7/)
})

test('files 契约：未做真实落盘核对时不否决（无 fs 事实 ≠ 不达标）', () => {
  const v = verdict({ satisfied: false, missingArtifacts: ['dist/report.md'] })
  const unchecked = applyEvidenceVerdict(COMPLETED, v, false)
  assert.equal(unchecked.status, 'completed', '未核对不应误伤')
})

test('files 契约：做了真实落盘核对且产物确实没落盘时否决', () => {
  const v = verdict({ satisfied: false, missingArtifacts: ['dist/report.md'] })
  const checked = applyEvidenceVerdict(COMPLETED, v, true)
  assert.equal(checked.status, 'unverified')
  assert.match(checked.error ?? '', /dist\/report\.md/)
})

test('否决理由的优先级：先章节、再引用、最后落盘', () => {
  const v = verdict({
    satisfied: false,
    missingSections: ['结论'],
    citationCompliant: false,
    citationIssues: ['bad'],
    missingArtifacts: ['a.md'],
  })
  const reason = evidenceRejection(v, true)
  assert.ok(reason !== undefined)
  assert.match(reason, /missing required sections/)
  assert.doesNotMatch(reason, /a\.md/)
})

// ── 契约要求面：CEO 必须把"要交什么"讲给 worker，否则契约永远满足不了 ──────────

test('contractBrief 读出契约的要求面（与账本同口径）', () => {
  const brief = contractBrief({
    form: 'files',
    required_sections: ['findings', 'risks'],
    artifacts: ['dist/report.md'],
    citation_mode: 'two_phase',
  })
  assert.deepEqual(brief, {
    form: 'files',
    requiredSections: ['findings', 'risks'],
    artifacts: ['dist/report.md'],
    citationMode: 'two_phase',
  })
})

test('contractBrief 对垃圾输入不抛错，并按账本默认值回落', () => {
  assert.equal(contractBrief(undefined), undefined)
  assert.equal(contractBrief(null), undefined)
  assert.equal(contractBrief('files'), undefined)
  assert.deepEqual(contractBrief({}), {
    form: 'prose',
    requiredSections: [],
    artifacts: [],
    citationMode: '',
  })
  // 非法枚举值不穿透（账本按 'prose' / '' 处理，这里必须一致）。
  assert.deepEqual(contractBrief({ form: 'binary', citation_mode: 'one_phase', required_sections: 'oops' }), {
    form: 'prose',
    requiredSections: [],
    artifacts: [],
    citationMode: '',
  })
})

test('默认契约是"软"的：不带任何要求，因此不可能否决任何交付', () => {
  const brief = contractBrief(DEFAULT_DELIVERY_CONTRACT)
  assert.ok(brief !== undefined)
  assert.deepEqual(brief.requiredSections, [])
  assert.deepEqual(brief.artifacts, [])
  assert.equal(brief.citationMode, '')
  assert.equal(brief.form, 'prose')
  // 空要求 + 非 two_phase ⇒ 即使物证完全为空也不构成否决。
  assert.equal(evidenceRejection(verdict({ satisfied: true }), false), undefined)
})
