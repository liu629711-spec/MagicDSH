/**
 * 验收判定（纯函数）：只基于 契约 + 物证 + 实际落盘事实，不读 worker 自述文本。
 *
 * 设计要点（对照 Magic 当前痛点——用正则解析 worker 自由文本状态行判定完成）：
 * - 必需章节是否齐全：取自结构化物证的 sectionsProduced，不读自由文本；
 * - 产物是否全部落盘：交叉核对"实际落盘事实"（真实文件系统检查结果）；
 * - 引用是否合规：two_phase 模式下，物证自报的引用必须落在"已核验引用集"内。
 */

import { validateContract, type ContractIssue, type DeliveryContract } from './contract.ts'
import type { EvidenceRecord } from './evidence.ts'

/**
 * 实际落盘事实（真实检查得来，不是成员自报）：
 * - landedPaths：真实存在的落盘路径（归一化）；
 * - verifiedCitationIds：引用台账中 deep_read/selected 的已核验引用 id。
 */
export interface GroundTruth {
  landedPaths: string[]
  verifiedCitationIds: string[]
}

export interface AcceptanceVerdict {
  /** 契约本身是否良构（无 error 级问题）。 */
  contractValid: boolean
  contractIssues: ContractIssue[]
  /** 交付是否满足契约（全部检查通过）。 */
  satisfied: boolean
  /** 缺失的必需章节（契约要求但物证未自报）。 */
  missingSections: string[]
  /** 未落盘声明的产物（契约声明但真实落盘中无匹配）。 */
  missingArtifacts: string[]
  /** 引用是否合规。 */
  citationCompliant: boolean
  citationIssues: string[]
  /** 是否启用严格模式（影响调用方处置，不改变 satisfied 布尔）。 */
  strict: boolean
  /** 是否对产物做了落盘核对（仅 files 形态为 true）。 */
  artifactsChecked: boolean
}

/** 路径归一化：统一为正斜杠、去多余斜杠、去前导 ./、去尾斜杠。 */
function normalizeRelPath(path: string): string {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
}

/** 把 glob 模式转成正则（* 匹配任意，? 单字符，[...] 字符类）。 */
function globToRegExp(pattern: string): RegExp {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? ''
    if (c === '*') {
      re += '.*'
    } else if (c === '?') {
      re += '.'
    } else if (c === '[') {
      const close = pattern.indexOf(']', i)
      if (close === -1) {
        re += '\\['
        continue
      }
      let cls = pattern.slice(i + 1, close)
      if (cls.startsWith('!') || cls.startsWith('^')) cls = '^' + cls.slice(1)
      re += '[' + cls + ']'
      i = close
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
  }
  re += '$'
  return new RegExp(re)
}

/**
 * 声明产物是否命中某个真实落盘路径（对齐 AgentCore file_acceptance.landed_matches_declared）：
 * 归一化后精确相等；声明以 / 结尾表示目录前缀；含 glob 字符按全路径匹配。
 */
export function landedMatchesDeclared(landedPaths: readonly string[], declared: string): boolean {
  const raw = String(declared).replace(/\\/g, '/')
  const isDir = raw.endsWith('/')
  const pattern = raw.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/+$/, '')
  if (pattern === '') return false
  const hasGlob = pattern.includes('*') || pattern.includes('?') || pattern.includes('[')
  const globRe = hasGlob ? globToRegExp(pattern) : null
  for (const lp of landedPaths) {
    const actual = normalizeRelPath(lp)
    if (actual === '') continue
    if (isDir) {
      if (actual === pattern || actual.startsWith(pattern + '/')) return true
    } else if (globRe !== null) {
      if (globRe.test(actual)) return true
    } else if (actual === pattern) {
      return true
    }
  }
  return false
}

/**
 * 验收判定（纯函数）。输入仅 契约 + 物证 + 实际落盘事实。
 */
export function verifyDelivery(
  contract: DeliveryContract,
  evidence: EvidenceRecord,
  ground: GroundTruth,
): AcceptanceVerdict {
  const contractIssues = validateContract(contract)
  const contractValid = !contractIssues.some((issue) => issue.level === 'error')

  // 章节：取自结构化物证，不读自由文本。
  const produced = new Set(evidence.sectionsProduced)
  const missingSections = contract.requiredSections.filter((section) => !produced.has(section))

  // 产物落盘：仅 files 形态需要；交叉核对真实落盘事实。
  const artifactsChecked = contract.form === 'files'
  const missingArtifacts: string[] = []
  if (artifactsChecked) {
    for (const artifact of contract.artifacts) {
      if (!landedMatchesDeclared(ground.landedPaths, artifact)) missingArtifacts.push(artifact)
    }
  }

  // 引用合规：two_phase 要求全部落在已核验集。
  const citationIssues: string[] = []
  let citationCompliant = true
  if (contract.citationMode === 'two_phase') {
    const verified = new Set(ground.verifiedCitationIds)
    if (evidence.citations.length === 0) {
      citationCompliant = false
      citationIssues.push('two_phase contract requires verified citations but none reported')
    }
    for (const id of evidence.citations) {
      if (!verified.has(id)) {
        citationCompliant = false
        citationIssues.push(`citation ${id} is not in the verified set`)
      }
    }
  }

  const satisfied =
    contractValid &&
    missingSections.length === 0 &&
    (artifactsChecked ? missingArtifacts.length === 0 : true) &&
    citationCompliant

  return {
    contractValid,
    contractIssues,
    satisfied,
    missingSections,
    missingArtifacts,
    citationCompliant,
    citationIssues,
    strict: contract.strict,
    artifactsChecked,
  }
}
