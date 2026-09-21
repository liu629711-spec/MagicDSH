/**
 * magic-ledger 插件入口：name / inject / apply（契约内核 §1.2）。
 *
 * 职责：
 * - open 自己的 storage 域 magic_ledger（layout=per-record，物证大、稀疏、可单独丢弃）；
 * - 注册两个工具：ledger_record_evidence（落盘自报物证）、ledger_verify（基于物证验收）；
 * - 通过 ctx.effect 注册 close disposer（内核 §3.4）。
 *
 * apply 不 import 任何 @deepseek-ai/dsh-* 包：ctx 是鸭子类型，storageDomain 端口从参数注入，
 * 测试时注入内存端口（createMemoryPort）。
 */

import { passthrough, StorageUnavailableError, type MagicDomain, type MagicDomainSpec, type StorageDomainPort } from './store.ts'
import { normalizeContract, type DeliveryContract } from './contract.ts'
import { getContract, latestEvidenceOfRun, makeEvidenceId, recordContract, recordEvidence, type EvidenceRecord } from './evidence.ts'
import { verifyDelivery, type AcceptanceVerdict, type GroundTruth } from './acceptance.ts'

export const name = 'magic-ledger'

/** Cordis 服务名（不是包名）；缺 storageDomain 时插件不激活。 */
export const inject = ['tools', 'storageDomain']

/** magic_ledger 域：version 1，per-record 布局（物证稀疏、可单独丢弃）。 */
const LEDGER_DOMAIN: MagicDomainSpec = {
  name: 'magic_ledger',
  version: 1,
  layout: 'per-record',
  tables: {
    contracts: { valueSchema: passthrough<unknown>() },
    evidence: { valueSchema: passthrough<unknown>() },
  },
}

interface LedgerToolsService {
  register(tool: {
    name: string
    description: string
    parameters: unknown
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown, exec?: unknown) => Promise<unknown> | unknown
  }): unknown
}

interface LedgerContext {
  tools: LedgerToolsService
  storageDomain?: StorageDomainPort
  // Cordis effect(setup)：setup 立即执行，其返回值（可为 disposer 函数）由宿主在卸载时调用。
  effect?: (setup: () => void | Promise<void> | (() => void)) => void
  emit?: (event: string, payload: unknown) => void
  on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown
  /** Cordis 服务注册（Magic 内部跨插件服务，契约内核 §2.1.1）。 */
  provide?: (name: string, value: unknown) => unknown
}

/**
 * `magicLedger` 服务面（Magic 内部跨插件服务）。
 *
 * 消费方（magic-ceo）用 `ctx.get('magicLedger')` 可选读取：服务不存在时拿到 undefined，
 * 不写进 `inject` 即可保持"账本没挂载 = 行为完全不变"。
 */
export interface MagicLedgerService {
  /** 登记一份交付契约（按 contractId 幂等写入）。 */
  putContract(contractId: string, contract: unknown): Promise<void>
  /** 读回一份契约。 */
  getContract(contractId: string): DeliveryContract | undefined
  /** 某 run 的最新物证。 */
  latestEvidence(runId: string): EvidenceRecord | undefined
  /**
   * 基于契约 + 物证 + 地面事实做验收判定。
   * 找不到契约时返回 undefined —— 调用方据此判断"无可验之物"，不做否决。
   */
  verify(runId: string, contractId: string, ground: GroundTruth): AcceptanceVerdict | undefined
}

function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 物证/契约 id 会成为 DSH storage-json 的 per-record 落盘 key，官方强制 path-safe
 * `[a-zA-Z0-9_-]+`（storage-json/src/per-record-unit.ts assertSafeKey）。在工具边界
 * 就拒绝不安全 id 并给出可读报错，而不是等落盘时抛天书异常。
 */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/

function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(
      `${field} '${value}' is not path-safe (must match [a-zA-Z0-9_-]+). `
      + 'Use an ASCII id, or ask the CEO for the run\'s minted run_id.',
    )
  }
}

export async function apply(ctx: LedgerContext): Promise<void> {
  const facility = ctx.storageDomain
  if (facility === undefined) throw new StorageUnavailableError()
  const domain: MagicDomain = await facility.open(LEDGER_DOMAIN)
  console.log('[magic-ledger] plugin loaded')
  // Cordis 的 effect 语义是 `effect(setup)`：setup **立即执行**，其返回值才是 disposer。
  // 写成 `ctx.effect(() => domain.close())` 会当场把域关掉。
  if (ctx.effect !== undefined) ctx.effect(() => () => domain.close())

  // ── ledger_record_evidence：落盘自报物证 ──────────────────────────────
  ctx.tools.register({
    name: 'ledger_record_evidence',
    description:
      'Record a worker\'s landed-evidence self-report for a run: which files actually '
      + 'touched disk, which required sections were produced, and which citations were used. '
      + 'This is the evidence the ledger accepts against, not the worker\'s free-text status line.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'Run (worker session) id this evidence belongs to.' },
        contract_id: { type: 'string', description: 'Optional contract id this evidence settles against.' },
        contract: {
          type: 'object',
          description: 'Optional delivery contract to persist alongside the evidence (form/required_sections/artifacts/...).',
        },
        landed_paths: { type: 'array', items: { type: 'string' }, description: 'Paths the worker claims it wrote to disk.' },
        sections_produced: { type: 'array', items: { type: 'string' }, description: 'Required sections the worker produced.' },
        citations: { type: 'array', items: { type: 'string' }, description: 'Citation ids the worker used (two_phase acceptance checks these).' },
        note: { type: 'string', description: 'Optional note.' },
      },
      required: ['run_id'],
    },
    output: {
      schema: { type: 'object', properties: { evidence_id: { type: 'string' } }, required: ['evidence_id'] },
      render: textRender,
    },
    async execute(args: unknown) {
      const raw = (args ?? {}) as Record<string, unknown>
      const runId = typeof raw.run_id === 'string' ? raw.run_id : ''
      if (runId === '') throw new Error('ledger_record_evidence requires run_id')
      assertSafeId(runId, 'run_id')
      const contractId = typeof raw.contract_id === 'string' ? raw.contract_id : ''
      const record: EvidenceRecord = {
        id: makeEvidenceId(runId),
        runId,
        contractId,
        recordedAt: new Date().toISOString(),
        landedPaths: asStringArray(raw.landed_paths),
        sectionsProduced: asStringArray(raw.sections_produced),
        citations: asStringArray(raw.citations),
        ...typeof raw.note === 'string' && raw.note.trim() !== '' ? { note: raw.note.trim() } : {},
      }
      await recordEvidence(domain, record)
      if (contractId !== '' && raw.contract !== undefined && raw.contract !== null) {
        const parsed = normalizeContract(raw.contract)
        await recordContract(domain, contractId, parsed)
      }
      ctx.emit?.('magic:ledger:evidence-recorded', { runId, evidenceId: record.id, contractId })
      return { evidence_id: record.id }
    },
  })

  // ── ledger_verify：基于物证验收 ───────────────────────────────────────
  ctx.tools.register({
    name: 'ledger_verify',
    description:
      'Accept a run against its delivery contract using only structured evidence + real on-disk facts. '
      + 'Never reads the worker\'s free-text status line. Returns whether the contract is satisfied, '
      + 'which required sections are missing, which artifacts failed to land, and citation compliance.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'Run (worker session) id to verify.' },
        contract_id: { type: 'string', description: 'Optional contract id to load from the ledger.' },
        contract: { type: 'object', description: 'Optional inline contract (used when contract_id not found).' },
        landed_paths: { type: 'array', items: { type: 'string' }, description: 'Real on-disk paths (ground truth).' },
        verified_citation_ids: { type: 'array', items: { type: 'string' }, description: 'Verified citation ids (deep_read/selected).' },
      },
      required: ['run_id'],
    },
    output: {
      schema: { type: 'object', properties: { satisfied: { type: 'boolean' } }, required: ['satisfied'] },
      render: textRender,
    },
    async execute(args: unknown) {
      const raw = (args ?? {}) as Record<string, unknown>
      const runId = typeof raw.run_id === 'string' ? raw.run_id : ''
      if (runId === '') throw new Error('ledger_verify requires run_id')
      assertSafeId(runId, 'run_id')

      let contract: DeliveryContract
      const contractId = typeof raw.contract_id === 'string' ? raw.contract_id : ''
      if (contractId !== '') assertSafeId(contractId, 'contract_id')
      const stored = contractId !== '' ? getContract(domain, contractId) : undefined
      if (stored !== undefined) {
        contract = stored
      } else if (raw.contract !== undefined && raw.contract !== null) {
        contract = normalizeContract(raw.contract)
      } else {
        throw new Error('ledger_verify requires contract_id (with a stored contract) or an inline contract')
      }

      const evidence = latestEvidenceOfRun(domain, runId) ?? {
        id: '',
        runId,
        contractId,
        recordedAt: '',
        landedPaths: [],
        sectionsProduced: [],
        citations: [],
      }
      const ground: GroundTruth = {
        landedPaths: asStringArray(raw.landed_paths),
        verifiedCitationIds: asStringArray(raw.verified_citation_ids),
      }
      const verdict = verifyDelivery(contract, evidence, ground)
      ctx.emit?.('magic:ledger:verified', { runId, contractId, satisfied: verdict.satisfied })
      return verdict
    },
  })

  // ── magicLedger 服务：供 magic-ceo 等服务层直调（不经过模型可见工具面） ──
  // 消费方用 ctx.get('magicLedger') 可选读取，因此本服务不是硬依赖。
  const service: MagicLedgerService = {
    async putContract(contractId, contract) {
      assertSafeId(contractId, 'contract_id')
      await recordContract(domain, contractId, normalizeContract(contract))
    },
    getContract(contractId) {
      return getContract(domain, contractId)
    },
    latestEvidence(runId) {
      return latestEvidenceOfRun(domain, runId)
    },
    verify(runId, contractId, ground) {
      const contract = contractId !== '' ? getContract(domain, contractId) : undefined
      if (contract === undefined) return undefined
      const evidence = latestEvidenceOfRun(domain, runId) ?? {
        id: '',
        runId,
        contractId,
        recordedAt: '',
        landedPaths: [],
        sectionsProduced: [],
        citations: [],
      }
      return verifyDelivery(contract, evidence, ground)
    },
  }
  ctx.provide?.('magicLedger', service)
}
