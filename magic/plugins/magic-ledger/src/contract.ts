/**
 * 交付契约类型 + 归一化 + 校验（纯函数，无副作用）。
 *
 * 字段对齐 AgentCore delegate/schema.py 的 TASK_DELIVERABLE_SCHEMA：
 * form / required_sections / output_format / artifacts / artifact_dir /
 * workspace_native / citation_mode / strict。
 *
 * 关键语义（来自 AgentCore）：
 * - form='prose' 表示"看"（无需落盘）；form='files' 表示"用"（必须落盘）。
 * - strict=true 表示不达标硬退；false 表示软接受。
 * - citation_mode='two_phase' 表示两阶段引用核验。
 */

export type DeliveryForm = 'prose' | 'files'
export type OutputFormat = 'text' | 'json'
export type CitationMode = 'two_phase' | ''

export interface DeliveryContract {
  /** 交付形态：prose=看；files=用（须落盘）。 */
  form: DeliveryForm
  /** 必需章节（结构化物证按此核对，不读自由文本）。 */
  requiredSections: string[]
  /** 输出格式。 */
  outputFormat: OutputFormat
  /** 声明产物清单（路径 / glob / 目录前缀）。 */
  artifacts: string[]
  /** 约定落盘目录。 */
  artifactDir: string
  /** true=用户工作区原生文件（改代码/写测试）。 */
  workspaceNative: boolean
  /** 两阶段引用核验模式，空串表示非两阶段。 */
  citationMode: CitationMode
  /** true=不达标硬退；false=软接受。 */
  strict: boolean
}

export type ContractIssueLevel = 'error' | 'warning'

export interface ContractIssue {
  level: ContractIssueLevel
  field: string
  message: string
}

export const DELIVERY_FORMS: readonly DeliveryForm[] = ['prose', 'files']
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json']
export const CITATION_MODES: readonly CitationMode[] = ['two_phase', '']

/** 把任意原始输入中的字符串数组合法项取出（忽略非字符串、去空）。 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item)
  }
  return out
}

/**
 * 从原始输入归一化为 DeliveryContract（纯函数，永不抛错）。
 * 未知 / 非法字段回落到安全默认值，保证下游可消费。
 */
export function normalizeContract(raw: unknown): DeliveryContract {
  const record =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const form = record.form === 'files' ? 'files' : 'prose'
  const outputFormat = record.output_format === 'json' ? 'json' : 'text'
  const citationMode = record.citation_mode === 'two_phase' ? 'two_phase' : ''
  return {
    form,
    requiredSections: asStringArray(record.required_sections),
    outputFormat,
    artifacts: asStringArray(record.artifacts),
    artifactDir: typeof record.artifact_dir === 'string' ? record.artifact_dir : '',
    workspaceNative: record.workspace_native === true,
    citationMode,
    strict: record.strict === true,
  }
}

/**
 * 校验契约是否良构（纯函数）。返回问题列表：
 * error 级会导致 contractValid=false（验收直接视为不达标）；
 * warning 级不阻断，但提示语义风险（如 files 形态却无落盘约束）。
 */
export function validateContract(contract: DeliveryContract): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (!DELIVERY_FORMS.includes(contract.form)) {
    issues.push({
      level: 'error',
      field: 'form',
      message: `form must be one of ${DELIVERY_FORMS.join('/')}, got ${String(contract.form)}`,
    })
  }
  if (!OUTPUT_FORMATS.includes(contract.outputFormat)) {
    issues.push({
      level: 'error',
      field: 'output_format',
      message: `output_format must be one of ${OUTPUT_FORMATS.join('/')}, got ${String(contract.outputFormat)}`,
    })
  }
  if (!CITATION_MODES.includes(contract.citationMode)) {
    issues.push({
      level: 'error',
      field: 'citation_mode',
      message: `citation_mode must be 'two_phase' or empty, got ${String(contract.citationMode)}`,
    })
  }
  if (contract.form === 'files' && contract.artifacts.length === 0 && contract.artifactDir.trim() === '') {
    issues.push({
      level: 'warning',
      field: 'artifacts',
      message: 'files form without artifacts or artifact_dir: no path constraint to verify landing',
    })
  }
  return issues
}

/** 一次性归一化 + 校验（纯函数）。 */
export function parseContract(raw: unknown): { contract: DeliveryContract; issues: ContractIssue[] } {
  const contract = normalizeContract(raw)
  return { contract, issues: validateContract(contract) }
}
