/**
 * 物证记录类型（落盘自报）+ 台账读写。
 *
 * 物证是结构化的落盘自报，区别于 worker 的自由文本状态行——
 * 验收只认"结构化物证 + 实际落盘事实"，不读成员自我描述文本。
 *
 * 读写走 store 端口（MagicDomain 表），测试注入内存端口，生产走 DSH 端口。
 */

import type { DeliveryContract } from './contract.ts'
import type { MagicDomain } from './store.ts'

/** 物证表名（匹配 /^[a-z][a-z0-9_]*$/）。 */
export const EVIDENCE_TABLE = 'evidence'
/** 契约表名。 */
export const CONTRACT_TABLE = 'contracts'

/**
 * 一条物证记录：成员结构化自报它"实际做了什么"。
 * 这是验收的物证来源，不是自由文本状态行。
 */
export interface EvidenceRecord {
  /** 物证 id，形如 ev_<runId>_<seq>。 */
  id: string
  /** 所属 run（成员会话）。 */
  runId: string
  /** 关联契约 id（可空，仅用于回指）。 */
  contractId: string
  /** 记录时间（ISO 字符串）。 */
  recordedAt: string
  /** 自报落盘路径（结构化，非自由文本）。 */
  landedPaths: string[]
  /** 自报已产出的必需章节。 */
  sectionsProduced: string[]
  /** 自报使用的引用 id（two_phase 验收需落在已核验集内）。 */
  citations: string[]
  /** 可选备注。 */
  note?: string
}

/** 生成物证 id。 */
export function makeEvidenceId(runId: string, seq?: number): string {
  const n = seq === undefined ? Date.now() : seq
  return `ev_${runId}_${n}`
}

/** 落盘一条物证（按 id 写入，重复 id 覆盖 = 幂等）。 */
export async function recordEvidence(domain: MagicDomain, record: EvidenceRecord): Promise<void> {
  await domain.table<EvidenceRecord>(EVIDENCE_TABLE).put(record.id, record)
}

/** 读取一条物证。 */
export function getEvidence(domain: MagicDomain, id: string): EvidenceRecord | undefined {
  return domain.table<EvidenceRecord>(EVIDENCE_TABLE).get(id)
}

/** 某 run 的全部物证（按登记顺序）。 */
export function evidenceOfRun(domain: MagicDomain, runId: string): EvidenceRecord[] {
  const out: EvidenceRecord[] = []
  for (const [, rec] of domain.table<EvidenceRecord>(EVIDENCE_TABLE).entries()) {
    if (rec.runId === runId) out.push(rec)
  }
  return out
}

/** 某 run 的最新一条物证（无则 undefined）。 */
export function latestEvidenceOfRun(domain: MagicDomain, runId: string): EvidenceRecord | undefined {
  const list = evidenceOfRun(domain, runId)
  return list.length > 0 ? list[list.length - 1] : undefined
}

/** 落盘一份契约（按 contractId 写入）。 */
export async function recordContract(
  domain: MagicDomain,
  contractId: string,
  contract: DeliveryContract,
): Promise<void> {
  await domain.table<DeliveryContract>(CONTRACT_TABLE).put(contractId, contract)
}

/** 读取一份契约。 */
export function getContract(domain: MagicDomain, contractId: string): DeliveryContract | undefined {
  return domain.table<DeliveryContract>(CONTRACT_TABLE).get(contractId)
}
