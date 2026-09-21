import type { RunPhase, RunSpec } from './plan.ts'

export type DeclaredResultStatus = 'completed' | 'blocked' | 'failed' | 'partial'
export type DeliveryStatus = DeclaredResultStatus | 'unverified'

export interface WorkerDelivery {
  phase: RunPhase
  status: DeliveryStatus
  error?: string
}

export function declaredResultStatus(output: string): DeclaredResultStatus | undefined {
  const match = output.match(/(?:"status"\s*:\s*|^\s*status\s*:\s*)(completed|blocked|failed|partial)\b/im)
  return match?.[1]?.toLowerCase() as DeclaredResultStatus | undefined
}

const EMPTY_DECISION = /^(none|n\/a|na|null|nil|empty|-|无|没有|暂无|无需|不需要|空|（空）|\(空\)|（无）|\(无\)|（暂无）|\[\]|\{\}|\[\s*\]|\{\s*\})$/i

// A negation word optionally followed by a parenthetical explanation, then at
// most a trailing clause — e.g. 「无（未遇到需要用户决策的分叉点）」 or
// 「没有，各区域数据已可交叉验证」. The explanation states WHY no decision is
// needed; it is not itself a question. Only a negation followed by real
// decision content (no leading negation, no enclosing brackets) counts.
const NEGATION_PREFIX = /^(?:none|n\/a|na|no|nothing|无|没有|暂无|无需|不需要|没有?\s*需要|没什么)\s*[（(]?[^（）()]*[)）]?\s*[，。：:、\s]?/i

function meaningfulDecision(text: string): string | undefined {
  let value = text.trim().replace(/[。.\s]+$/u, '').trim()
  if (value === '' || EMPTY_DECISION.test(value)) return undefined
  // 双重标签（user_decisions: 用户决策：…）在拼接输出里出现过，先剥掉。
  for (;;) {
    const stripped = value.replace(/^\s*(?:user_decisions|用户决策|待用户决策)\s*[:：]\s*/i, '')
    if (stripped === value) break
    value = stripped.trim()
  }
  // 「无（解释）」：剥掉否定词和括注后没有剩余内容 → 不是决策。
  const negationStripped = value.replace(NEGATION_PREFIX, '').trim()
  if (negationStripped === '') return undefined
  // 剩余部分若整体被括号包裹（如「无（未遇到…分叉点）」剥词后余
  // 「未遇到…分叉点」之外还有正文），仅当剩余文本仍以否定/无需开头或为空时
  // 才视为无决策；真实问题（「选 A 还是 B」）会通过。
  if (/^(?:无|没有|暂无|无需|不需要|none|no)\b/i.test(negationStripped)) return undefined
  return text.trim()
}

export function declaredUserDecisions(output: string): string | undefined {
  const json = output.match(/"user_decisions"\s*:\s*"((?:\\.|[^"\\])*)"/i)
  if (json?.[1] !== undefined) {
    const fromJson = meaningfulDecision(json[1].replace(/\\n/g, '\n'))
    if (fromJson !== undefined) return fromJson
  }
  const labeled = output.match(/^\s*(?:user_decisions|用户决策|待用户决策)\s*[:：]\s*(.+)$/imu)
  const text = labeled?.[1]?.trim()
  if (text === undefined) return undefined
  return meaningfulDecision(text)
}

export function hasResearchEvidenceGap(spec: Pick<RunSpec, 'role' | 'task'>, output: string): boolean {
  if (!/research|survey|market|compare|competitive|调研|研究|市场|比较|竞品|多来源|多视角/i.test(`${spec.role} ${spec.task}`)) {
    return false
  }
  return /无法联网|无法核验|联网失败|网络不可[用达]|(?:web_)?search[^\n。]{0,12}不可[用达]|HTTP\s*405|出站网络|仅.*估计|未经核验|待联网|no internet|unable to verify|unverified/i.test(output)
}

/**
 * Map a worker stop + output onto an honest delivery status.
 * A completed stop without a structured result is unverified, not completed.
 * Declared completed/partial with a non-completed stop is unverified, not success.
 *
 * 研究证据缺口（无法联网/无法核验等）只在成员结构化交付（partial/completed）且
 * user_decisions 判定无真实问题时降级为 partial——缺口是成员已知并自行消化的
 * 局限，不挂起打扰用户。成员自称 blocked、无结构化结果、或真需要拍板时仍阻塞。
 */
export function classifyWorkerDelivery(
  spec: Pick<RunSpec, 'role' | 'task'>,
  output: string,
  stopReason: string,
): WorkerDelivery {
  const declared = declaredResultStatus(output)
  const decisions = declaredUserDecisions(output)
  if (decisions !== undefined) {
    return { phase: 'blocked', status: 'blocked', error: decisions }
  }
  const evidenceGap = hasResearchEvidenceGap(spec, output)
  if (declared === 'blocked' || (evidenceGap && declared === undefined)) {
    return { phase: 'failed', status: 'blocked', error: 'worker result blocked by evidence gap' }
  }
  if (declared === 'failed') {
    return { phase: 'failed', status: 'failed', error: 'worker declared failure' }
  }
  if (stopReason !== 'completed') {
    return {
      phase: 'unverified',
      status: 'unverified',
      error: `worker did not complete: ${stopReason}`,
    }
  }
  if (evidenceGap && (declared === 'partial' || declared === 'completed')) {
    // 成员带着已知数据局限交付且无需用户拍板 → partial，流程继续不挂起。
    return { phase: 'completed', status: 'partial', error: 'worker delivered with a known evidence gap' }
  }
  if (declared === 'partial') return { phase: 'completed', status: 'partial' }
  if (declared === 'completed') return { phase: 'completed', status: 'completed' }
  return {
    phase: 'unverified',
    status: 'unverified',
    error: 'worker finished without a structured result',
  }
}

/** 契约的"要求面"摘要（CEO 只读这几项，用于告诉 worker 要交什么）。 */
export interface ContractBrief {
  form: 'prose' | 'files'
  requiredSections: string[]
  artifacts: string[]
  citationMode: 'two_phase' | ''
}

function briefStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/**
 * 防御性读取原始契约的要求面（跨插件不共享源码，所以按字段鸭子读取）。
 *
 * 缺省字段与 magic-ledger 的 `normalizeContract` 同口径回落，保证"CEO 告诉 worker 要交什么"
 * 与"账本验收按什么判"是同一套要求。非对象输入返回 undefined（视为无契约要求）。
 */
export function contractBrief(raw: unknown): ContractBrief | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  return {
    form: record.form === 'files' ? 'files' : 'prose',
    requiredSections: briefStrings(record.required_sections),
    artifacts: briefStrings(record.artifacts),
    citationMode: record.citation_mode === 'two_phase' ? 'two_phase' : '',
  }
}

/**
 * 默认交付契约（软契约）：账本在场时给每个节点兜底。
 *
 * 刻意**不带任何要求**（required_sections / artifacts 为空）：
 * 未达标的交付在 `wave.ts:14` 里等同失败，会连累下游被 skip，
 * 所以默认契约的职责只有一个 —— 让 worker 知道要交物证，
 * 它不会改变任何验收结论（空要求契约恒为 satisfied）。
 *
 * 要严，就在 `ceo_delegate` / `ceo_replan` 的任务上显式写 contract。
 */
export const DEFAULT_DELIVERY_CONTRACT = {
  form: 'prose',
  required_sections: [] as string[],
  output_format: 'text',
  artifacts: [] as string[],
  artifact_dir: '',
  workspace_native: false,
  citation_mode: '',
  strict: false,
}

/** 账本验收判定的只读视图（鸭子类型，不 import magic-ledger 源码）。 */
export interface EvidenceVerdictView {
  contractValid: boolean
  satisfied: boolean
  missingSections: readonly string[]
  missingArtifacts: readonly string[]
  citationCompliant: boolean
  citationIssues: readonly string[]
}

/**
 * 物证对自述结论的否决理由。返回 undefined 表示物证未推翻自述。
 *
 * 只把"证明不满足"当作否决依据，不把"无法核对"当作否决依据：
 * `missingArtifacts` 仅在调用方真的提供了地面落盘事实（landedPaths 非空）时参与否决，
 * 否则 files 形态契约在无法核对时会误伤所有交付。
 */
export function evidenceRejection(
  verdict: EvidenceVerdictView,
  landedPathsChecked: boolean,
): string | undefined {
  if (!verdict.contractValid) return 'delivery contract is malformed'
  if (verdict.missingSections.length > 0) {
    return `missing required sections: ${verdict.missingSections.join(', ')}`
  }
  if (!verdict.citationCompliant) {
    const detail = verdict.citationIssues.length > 0 ? verdict.citationIssues.join('; ') : 'citations not verified'
    return `citation check failed: ${detail}`
  }
  if (landedPathsChecked && verdict.missingArtifacts.length > 0) {
    return `declared artifacts never landed: ${verdict.missingArtifacts.join(', ')}`
  }
  return undefined
}

/**
 * 用物证验收结论复核自述交付结论。
 *
 * 只在自述声称"达标"（status=completed）时复核：物证能推翻自述，但不能把已经
 * 承认失败/部分完成的结论"改好"。物证不足（无契约、无物证）时不改变任何结论。
 */
export function applyEvidenceVerdict(
  delivery: WorkerDelivery,
  verdict: EvidenceVerdictView | undefined,
  landedPathsChecked: boolean,
): WorkerDelivery {
  if (verdict === undefined) return delivery
  if (delivery.status !== 'completed') return delivery
  const rejection = evidenceRejection(verdict, landedPathsChecked)
  if (rejection === undefined) return delivery
  return { phase: 'unverified', status: 'unverified', error: `evidence does not back the claim: ${rejection}` }
}
