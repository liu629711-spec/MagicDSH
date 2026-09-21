/**
 * 存储端口（契约内核 §2.2 / §3，复制 W0 约定， consolidated 为单文件）。
 *
 * 铁律：不 import 任何 `@deepseek-ai/dsh-*` 包。全部是结构化类型，靠鸭子匹配对接 DSH。
 * 本文件同时给出 magic_memory 域的声明（layout: 'per-record'）。
 */

import { recordSchema, type MemoryRecord } from './record.ts'

// ── 端口结构化类型（契约内核 §2.2） ────────────────────────────────────────

/** 校验器：只需 `.parse`。DSH 运行时只调这一个方法。 */
export interface ValueSchema<T> {
  parse(value: unknown): T
}

/** 域声明。手搓构造，不用 DSH 的 defineDomain（它只是校验用的恒等函数）。 */
export interface MagicDomainSpec {
  /** 必须匹配 /^[a-z][a-z0-9_]*$/（DSH UNIT_NAME_RE）。 */
  readonly name: string
  /** 非负整数。 */
  readonly version: number
  /** 默认 'single'：整域一个文档；'per-record'：每条记录一个文档。 */
  readonly layout?: 'single' | 'per-record'
  readonly global?: {
    readonly schema: ValueSchema<unknown>
    readonly initial: unknown
  }
  readonly tables: Record<string, { readonly valueSchema: ValueSchema<unknown> }>
}

/** 表句柄。读同步、写持久。 */
export interface MagicTable<T> {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, updater: (current: T) => T): Promise<T>
}

/** 已打开的域。 */
export interface MagicDomain {
  readonly name: string
  table<T>(name: string): MagicTable<T>
  close(): Promise<void>
}

/** 存储端口。生产走 DSH 适配器，测试走内存适配器。 */
export interface StorageDomainPort {
  open(spec: MagicDomainSpec): Promise<MagicDomain>
}

// ── schema 帮助函数（契约内核 §3.2） ──────────────────────────────────────

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

function acceptsNull(validator: ValueSchema<unknown>): boolean {
  try {
    validator.parse(null)
    return true
  } catch {
    return false
  }
}

/**
 * 校验并归一化域声明，镜像 DSH `defineDomain` 的检查。
 * DSH 的 open() 本身不调用 defineDomain，所以这里必须自己把关。
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
    throw new DomainSpecError(
      `domain '${spec.name}' global schema must not accept null: `
      + 'null is the medium\'s "never written" sentinel, so a stored null could not round-trip',
    )
  }
  return spec
}

// ── 内存端口（契约内核 §3.3，单元测试用） ─────────────────────────────────

const noop = (): void => {}

interface DomainState {
  closed: boolean
}

class MemoryTable<T> implements MagicTable<T> {
  private readonly records: Map<string, T>
  private readonly state: DomainState
  private chain: Promise<void> = Promise.resolve()

  constructor(records: Map<string, T>, state: DomainState) {
    this.records = records
    this.state = state
  }

  get(key: string): T | undefined {
    this.assertReadable()
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, T]> {
    this.assertReadable()
    return [...this.records.entries()][Symbol.iterator]()
  }

  keys(): IterableIterator<string> {
    this.assertReadable()
    return [...this.records.keys()][Symbol.iterator]()
  }

  get size(): number {
    this.assertReadable()
    return this.records.size
  }

  put(key: string, value: T): Promise<void> {
    return this.enqueue(async () => {
      this.records.set(key, value)
    })
  }

  delete(key: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.records.has(key)) return false
      this.records.delete(key)
      return true
    })
  }

  update(key: string, updater: (current: T) => T): Promise<T> {
    return this.enqueue(async () => {
      if (!this.records.has(key)) {
        throw new Error(`update: record '${key}' does not exist`)
      }
      const next = updater(this.records.get(key) as T)
      this.records.set(key, next)
      return next
    })
  }

  private assertReadable(): void {
    if (this.state.closed) throw new Error('domain is closed')
  }

  private enqueue<R>(job: () => Promise<R>): Promise<R> {
    if (this.state.closed) return Promise.reject(new Error('domain is closed'))
    const result = this.chain.then(job)
    this.chain = result.then(noop, noop)
    return result
  }
}

class MemoryDomain implements MagicDomain {
  readonly name: string
  private readonly tables = new Map<string, MemoryTable<unknown>>()
  private readonly state: DomainState = { closed: false }
  private readonly onClosed: () => void

  constructor(spec: MagicDomainSpec, onClosed: () => void) {
    this.name = spec.name
    this.onClosed = onClosed
    for (const table of Object.keys(spec.tables)) {
      this.tables.set(table, new MemoryTable<unknown>(new Map(), this.state))
    }
  }

  table<T>(name: string): MagicTable<T> {
    if (this.state.closed) throw new Error(`domain '${this.name}' is closed`)
    const table = this.tables.get(name)
    if (table === undefined) {
      throw new Error(`domain '${this.name}' declares no table '${name}'`)
    }
    return table as unknown as MagicTable<T>
  }

  close(): Promise<void> {
    if (this.state.closed) return Promise.resolve()
    this.state.closed = true
    this.onClosed()
    return Promise.resolve()
  }
}

/** 创建内存端口。单域名单次 open 的约束与 DSH 一致（内核 §4）。 */
export function createMemoryPort(): StorageDomainPort {
  const openNames = new Set<string>()
  return {
    open(spec: MagicDomainSpec): Promise<MagicDomain> {
      if (openNames.has(spec.name)) {
        return Promise.reject(new Error(`domain '${spec.name}' is already open`))
      }
      openNames.add(spec.name)
      return Promise.resolve(new MemoryDomain(spec, () => { openNames.delete(spec.name) }))
    },
  }
}

// ── DSH 端口（契约内核 §3.3，生产用） ──────────────────────────────────────

/** `ctx.storageDomain` 的结构化形状。 */
export interface DshStorageDomainFacility {
  open(spec: MagicDomainSpec): Promise<unknown>
}

/** 宿主 ctx 的最小投影：只需要 storageDomain。 */
export interface StorageHostLike {
  storageDomain?: DshStorageDomainFacility
}

export class StorageUnavailableError extends Error {
  constructor() {
    super(
      'ctx.storageDomain is unavailable: the DSH profile did not load '
      + '@deepseek-ai/dsh-storage + @deepseek-ai/dsh-storage-json + @deepseek-ai/dsh-storage-domain. '
      + 'Add the storage rows to the composition, or inject an in-memory port for tests.',
    )
    this.name = 'StorageUnavailableError'
  }
}

/**
 * 创建 DSH 端口。
 * @param host - 宿主 ctx（鸭子类型，只需 storageDomain）。
 * @returns 转发到 `ctx.storageDomain` 的端口。
 */
export function createDshPort(host: StorageHostLike): StorageDomainPort {
  const facility = host.storageDomain
  if (facility === undefined) throw new StorageUnavailableError()
  return {
    async open(spec: MagicDomainSpec): Promise<MagicDomain> {
      return await facility.open(spec) as MagicDomain
    },
  }
}

// ── magic_memory 域声明（内核 §4：单域、per-record） ───────────────────────

/** magic_memory 域声明：记忆大、稀疏、可单独丢弃，故选 per-record。 */
export function buildMemorySpec(): MagicDomainSpec {
  return {
    name: 'magic_memory',
    version: 1,
    layout: 'per-record',
    tables: {
      memories: { valueSchema: recordSchema() as unknown as ValueSchema<unknown> },
    },
  }
}

/** 记忆表的强类型句柄，便于业务模块直接使用。 */
export type MemoryTableHandle = MagicTable<MemoryRecord>
