/**
 * 内存存储端口（契约内核 §3.3）。单元测试用，语义对齐 DSH：
 * 读同步、写 Promise、update 串行、delete 返回是否存在、单域名单次 open、
 * 关闭后读抛错、关闭后写拒绝、关闭后释放域名。
 *
 * 为什么必须有它：插件目录下的 tests 不加载真实 DSH（内核 §2.6），
 * 内存端口让全部业务逻辑可测；DSH 端口由 W5 升级体检验证。
 */
import type { MagicDomain, MagicDomainSpec, MagicTable, StorageDomainPort } from './types.ts'

const noop = (): void => {}

/** 域级共享状态：mirror DSH 的 `assertReadable()` 与写链条闸门。 */
interface DomainState {
  closed: boolean
}

class MemoryTable<T> implements MagicTable<T> {
  private readonly records: Map<string, T>
  private readonly state: DomainState
  /** 单条写链：mirror DSH 的 per-domain write chain（storage-domain/src/domain.ts:148-153）。 */
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

  constructor(spec: MagicDomainSpec, backing: MemoryBacking, onClosed: () => void) {
    this.name = spec.name
    this.onClosed = onClosed
    for (const table of Object.keys(spec.tables)) {
      // 记录从共享后端取（而非新建），这样"关闭 → 重新 open"能读到上次的数据，
      // 等价于真实后端的"进程重启后数据仍在"。
      const backingKey = `${spec.name}/${table}`
      let records = backing.get(backingKey)
      if (records === undefined) {
        records = new Map<string, unknown>()
        backing.set(backingKey, records)
      }
      this.tables.set(table, new MemoryTable<unknown>(records, this.state))
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
    // 与 DSH 一致：关闭后释放域名，允许后续重新 open（domain.ts:236-244）。
    this.onClosed()
    return Promise.resolve()
  }
}

/** 共享后端：跨 open/close 保留记录，用于模拟进程重启后的持久性。 */
export type MemoryBacking = Map<string, Map<string, unknown>>

/** 新建一个空后端。 */
export function createMemoryBacking(): MemoryBacking {
  return new Map()
}

/**
 * 创建内存端口。
 * @param backing - 共享后端。传入同一个后端可模拟"重启后数据仍在"；省略则每次全新。
 */
export function createMemoryPort(backing: MemoryBacking = createMemoryBacking()): StorageDomainPort {
  const openNames = new Set<string>()
  return {
    open(spec: MagicDomainSpec): Promise<MagicDomain> {
      if (openNames.has(spec.name)) {
        return Promise.reject(new Error(`domain '${spec.name}' is already open`))
      }
      openNames.add(spec.name)
      return Promise.resolve(new MemoryDomain(spec, backing, () => { openNames.delete(spec.name) }))
    },
  }
}
