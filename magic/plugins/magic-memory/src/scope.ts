/**
 * 作用域链（对齐 AgentCore memory/scope_chain.py 的产品语义，完全重写）。
 *
 * Magic 当前是两级受众：'ceo'（私有）⊇ 'member'（共享）。作用域链把
 * 「某个请求方能看到哪些受众」显式化，检索与注入统一从这里取链，而不是散落
 * 各处的 if——未来引入第三级受众（如 'engineering'，PRD-03）时只改本文件。
 */

import type { MemoryAudience } from './record.ts'

/** 受众的可见性顺序：链上越靠前越私有。 */
export const SCOPE_CHAIN: readonly MemoryAudience[] = ['ceo', 'member']

/** 某请求方受众能看到的所有受众（含自身）。 */
export function visibleAudiencesOf(audience: MemoryAudience): readonly MemoryAudience[] {
  const index = SCOPE_CHAIN.indexOf(audience)
  if (index === -1) return [audience]
  return SCOPE_CHAIN.slice(index)
}

/** 判定一条记录对请求方是否可见（作用域链的唯一真相，供 isVisibleTo 复用）。 */
export function isVisibleOnChain(
  recordAudience: MemoryAudience,
  requesterAudience: MemoryAudience,
): boolean {
  return visibleAudiencesOf(requesterAudience).includes(recordAudience)
}
