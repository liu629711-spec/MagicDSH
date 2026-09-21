/**
 * 存储端口类型（契约内核 §2.2 / §3）。
 *
 * 铁律：不 import 任何 `@deepseek-ai/dsh-*` 包。这里全部是结构化类型，
 * 靠鸭子匹配对接 DSH 的 `ctx.storageDomain`。
 */

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
