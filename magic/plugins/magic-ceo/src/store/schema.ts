/**
 * 域与校验器帮助函数（契约内核 §3.2）。
 *
 * 零依赖：不引入 zod。DSH 的 storage-domain 运行时只调用 `valueSchema.parse`，
 * 所以任何带 `.parse` 的对象都能用 —— 这里手搓。
 */
import type { MagicDomainSpec, ValueSchema } from './types.ts'

/** DSH 的 UNIT_NAME_RE，出处 reference-project/deepseek-harness/packages/storage/storage/src/backend.ts:10 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

export class DomainSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainSpecError'
  }
}

/** 造一个只有 `.parse` 的校验器。 */
export function schema<T>(parse: (value: unknown) => T): ValueSchema<T> {
  return { parse }
}

/** 直通校验器：不做校验，仅类型断言。V1 默认实现，登记为后续升级点。 */
export function passthrough<T>(): ValueSchema<T> {
  return { parse: (value: unknown) => value as T }
}

/**
 * 校验并归一化域声明，镜像 DSH `defineDomain` 的检查
 * （storage-domain/src/spec.ts:87-114）。DSH 的 open() 本身不调用 defineDomain，
 * 所以这里必须自己把关，否则非法 spec 会在 open 时才炸。
 */
export function magicDomain(spec: MagicDomainSpec): MagicDomainSpec {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new DomainSpecError(`domain name '${spec.name}' must match ${String(UNIT_NAME_RE)}`)
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new DomainSpecError(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`)
  }
  if (spec.layout !== undefined && spec.layout !== 'single' && spec.layout !== 'per-record') {
    throw new DomainSpecError(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${String(spec.layout)}`)
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new DomainSpecError(`domain '${spec.name}' table name '${table}' must match ${String(UNIT_NAME_RE)}`)
    }
  }
  if (spec.global !== undefined && acceptsNull(spec.global.schema)) {
    // null 是介质上"从未写入"的哨兵：可空 global 无法与"未写入"区分（spec.ts:107-112）。
    throw new DomainSpecError(
      `domain '${spec.name}' global schema must not accept null: `
      + 'null is the medium\'s "never written" sentinel, so a stored null could not round-trip',
    )
  }
  return spec
}

function acceptsNull(validator: ValueSchema<unknown>): boolean {
  try {
    validator.parse(null)
    return true
  } catch {
    return false
  }
}
