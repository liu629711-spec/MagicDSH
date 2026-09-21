/**
 * DSH 存储端口（契约内核 §3.3）。
 *
 * 把 `ctx.storageDomain` 包成 `StorageDomainPort`。这里是**唯一的**对接点，
 * 全仓只有这一处提到 DSH 的存储形状，改上游时只改这里。
 *
 * 依据（reference-project/deepseek-harness）：
 * - `storage-domain/src/index.ts:35-39` —— Context 声明 `storageDomain: DomainFacility`
 * - `storage-domain/src/index.ts:100-156` —— `open(spec): Promise<Domain<S>>`
 * - `storage-domain/src/domain.ts:42-90` —— KvTable 方法集，与本地 MagicTable 同构
 */
import type { MagicDomain, MagicDomainSpec, StorageDomainPort } from './types.ts'

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
      // DSH 的 Domain<KvTable> 与本地 MagicDomain<MagicTable> 结构同构；类型擦除点仅此一处。
      return await facility.open(spec) as MagicDomain
    },
  }
}
