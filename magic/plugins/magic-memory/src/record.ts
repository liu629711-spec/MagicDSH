/**
 * 记忆记录类型、分层与作用域（W3 记忆插件）。
 *
 * 本文件只定义数据类型与构造/校验逻辑，不触碰 DSH，也不触碰存储端口。
 * 设计借鉴 AgentCore memory 的分层（episodic / semantic / user / rule）与作用域
 * 隔离（AUDIENCE_CEO / AUDIENCE_WORKER 思路），但完全重写，不搬运其代码。
 */

import { randomUUID } from 'node:crypto'
import type { ValueSchema } from './store.ts'

/** 记忆分层。 */
export type MemoryLayer = 'episodic' | 'semantic' | 'user' | 'rule'

/**
 * 记忆受众（作用域隔离的核心）。
 * - 'ceo'    ：仅 CEO 会话可见（CEO 私有记忆，成员看不到）。
 * - 'member' ：CEO 与成员都可见（共享记忆）。
 */
export type MemoryAudience = 'ceo' | 'member'

export const MEMORY_LAYERS: readonly MemoryLayer[] = ['episodic', 'semantic', 'user', 'rule']
export const MEMORY_AUDIENCES: readonly MemoryAudience[] = ['ceo', 'member']

/** 一条记忆记录。 */
export interface MemoryRecord {
  /** 稳定 id（写入后不变）。 */
  readonly id: string
  /** 分层。 */
  readonly layer: MemoryLayer
  /** 受众：决定谁能在检索/注入中看到它。 */
  readonly audience: MemoryAudience
  /** 正文。 */
  readonly content: string
  /** 检索标签。 */
  readonly tags: readonly string[]
  /** 来源标注（如哪个会话 / 工具写入）。 */
  readonly source: string
  /** 写入时间（ISO）。 */
  readonly createdAt: string
  /** 最后更新时间（ISO）。 */
  readonly updatedAt: string
  /**
   * 纠错通道标记：被用户否认的记忆不注入、不可检索（见 AgentCore dispute_line）。
   * 本轮只记录标记，不实现反向喂给巩固侧。
   */
  readonly disputed: boolean
}

/** 创建记忆所需的输入（id / 时间戳由构造器补齐）。 */
export interface NewMemoryInput {
  readonly layer: MemoryLayer
  readonly audience: MemoryAudience
  readonly content: string
  readonly tags?: readonly string[]
  readonly source?: string
}

export class RecordValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecordValidationError'
  }
}

function isMemoryLayer(value: unknown): value is MemoryLayer {
  return typeof value === 'string' && (MEMORY_LAYERS as readonly string[]).includes(value)
}

function isMemoryAudience(value: unknown): value is MemoryAudience {
  return typeof value === 'string' && (MEMORY_AUDIENCES as readonly string[]).includes(value)
}

function asTagList(value: unknown): readonly string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 构造一条记忆记录：补齐 id 与时间戳，并对输入做最小校验。 */
export function makeMemoryRecord(input: NewMemoryInput): MemoryRecord {
  if (!isMemoryLayer(input.layer)) {
    throw new RecordValidationError(`invalid memory layer: ${String(input.layer)}`)
  }
  if (!isMemoryAudience(input.audience)) {
    throw new RecordValidationError(`invalid memory audience: ${String(input.audience)}`)
  }
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.trim() === '') {
    throw new RecordValidationError('memory content must not be empty')
  }
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    layer: input.layer,
    audience: input.audience,
    content,
    tags: asTagList(input.tags),
    source: typeof input.source === 'string' ? input.source : '',
    createdAt: now,
    updatedAt: now,
    disputed: false,
  }
}

/**
 * 记录的存储校验器（契约内核 §3.2）：DSH 在 open 时读 `valueSchema.parse` 校验落盘值。
 * 这里做真实校验 + 归一化，而不是 passthrough —— 让非法落盘值在读取侧即被拦下。
 */
export function recordSchema(): ValueSchema<MemoryRecord> {
  return {
    parse(value: unknown): MemoryRecord {
      if (typeof value !== 'object' || value === null) {
        throw new RecordValidationError('memory record must be an object')
      }
      const record = value as Record<string, unknown>
      if (typeof record.id !== 'string' || record.id === '') {
        throw new RecordValidationError('memory record missing id')
      }
      if (!isMemoryLayer(record.layer)) {
        throw new RecordValidationError(`invalid memory layer: ${String(record.layer)}`)
      }
      if (!isMemoryAudience(record.audience)) {
        throw new RecordValidationError(`invalid memory audience: ${String(record.audience)}`)
      }
      if (typeof record.content !== 'string' || record.content.trim() === '') {
        throw new RecordValidationError('memory record missing content')
      }
      if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
        throw new RecordValidationError('memory record missing timestamps')
      }
      return {
        id: record.id,
        layer: record.layer,
        audience: record.audience,
        content: record.content,
        tags: asTagList(record.tags),
        source: typeof record.source === 'string' ? record.source : '',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        disputed: record.disputed === true,
      }
    },
  }
}
