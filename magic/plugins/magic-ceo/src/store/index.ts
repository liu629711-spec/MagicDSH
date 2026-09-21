/**
 * 存储端口统一出口（契约内核 §3.1）。
 *
 * 业务模块只依赖本目录导出的 `StorageDomainPort` / `MagicDomain` / `MagicTable`，
 * 不直接触碰 DSH 形状，也不直接碰 Map。
 */
export type {
  MagicDomain,
  MagicDomainSpec,
  MagicTable,
  StorageDomainPort,
  ValueSchema,
} from './types.ts'

export { DomainSpecError, magicDomain, passthrough, schema } from './schema.ts'
export { createMemoryBacking, createMemoryPort, type MemoryBacking } from './memory-port.ts'
export {
  createDshPort,
  StorageUnavailableError,
  type DshStorageDomainFacility,
  type StorageHostLike,
} from './dsh-port.ts'
export {
  CEO_DOMAIN_NAME,
  CEO_DOMAIN_VERSION,
  ceoDomainSpec,
  openCeoStore,
  recordKey,
  type CeoStore,
  type PersistedChannel,
  type PersistedMember,
  type PersistedPlan,
  type PersistedPlanTask,
  type PersistedUsage,
} from './ceo-domain.ts'
