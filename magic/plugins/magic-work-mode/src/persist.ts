import { type MagicWorkModeState, type WorkMode } from './mode.ts'

export const WORK_MODE_EVENT = 'magic/work-mode'
export const WORK_MODE_INPUT_EVENT = 'magic/work-mode-input'
export const WORK_MODE_CHANGED_EVENT = 'magic/work-mode-changed'

export interface WorkModeInputStamp {
  sessionId: string
  messageId: string
  mode: WorkMode
  sessionMode: WorkMode
  scope: 'session' | 'input'
}

export interface PersistSession {
  id?: string
  append?: (type: string, data: unknown) => unknown
  snapshotEvents?: () => ReadonlyArray<{ type?: string; data?: unknown }>
}

function isJournalEnvelope(value: object, type: string): boolean {
  const record = value as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
  return record.type === type
    && typeof record.seq === 'number'
    && typeof record.time === 'number'
    && record.data !== undefined
}

function appendIgnorable(session: PersistSession, type: string, data: unknown): void {
  if (typeof session.append !== 'function') return
  const freeze = Object.freeze
  Object.freeze = ((value: object) => {
    if (value !== null && typeof value === 'object' && isJournalEnvelope(value, type)) {
      (value as { ignorable?: true }).ignorable = true
    }
    return freeze(value)
  }) as typeof Object.freeze
  try {
    const event = session.append(type, data)
    if (event !== null && typeof event === 'object' && Object.isExtensible(event)) {
      (event as { ignorable?: true }).ignorable = true
    }
  } finally {
    Object.freeze = freeze
  }
}

function asWorkMode(value: unknown): WorkMode | undefined {
  return value === 'agent' || value === 'ceo' ? value : undefined
}

export function parseWorkModeEvent(data: unknown): MagicWorkModeState | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as { sessionMode?: unknown; inputMode?: unknown }
  const sessionMode = asWorkMode(record.sessionMode)
  if (sessionMode === undefined) return undefined
  if (record.inputMode === null) return { sessionMode, inputMode: null }
  const inputMode = asWorkMode(record.inputMode)
  if (inputMode === undefined) return undefined
  return { sessionMode, inputMode }
}

export function parseWorkModeClientEvent(data: unknown): {
  sessionId: string
  state: MagicWorkModeState
} | undefined {
  const state = parseWorkModeEvent(data)
  if (state === undefined || typeof data !== 'object' || data === null) return undefined
  const sessionId = (data as { sessionId?: unknown }).sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return { sessionId, state }
}

export function latestWorkModeRecord(session: PersistSession | undefined): {
  state: MagicWorkModeState
  data: unknown
} | undefined {
  const events = session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== WORK_MODE_EVENT) continue
    const parsed = parseWorkModeEvent(event.data)
    if (parsed !== undefined) return { state: parsed, data: event.data }
  }
  return undefined
}

export function latestWorkMode(session: PersistSession | undefined): MagicWorkModeState | undefined {
  return latestWorkModeRecord(session)?.state
}

export function persistWorkMode(
  session: PersistSession,
  state: MagicWorkModeState,
  sessionId = session.id,
): void {
  try {
    appendIgnorable(session, WORK_MODE_EVENT, {
      sessionMode: state.sessionMode,
      inputMode: state.inputMode,
      ...typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {},
    })
  } catch {
    // Work-mode persistence is observational; the in-memory map still owns the live turn.
  }
}

export function parseWorkModeInputEvent(data: unknown): WorkModeInputStamp | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as {
    sessionId?: unknown
    messageId?: unknown
    mode?: unknown
    sessionMode?: unknown
    scope?: unknown
  }
  const mode = asWorkMode(record.mode)
  const sessionMode = asWorkMode(record.sessionMode)
  if (mode === undefined || sessionMode === undefined) return undefined
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return undefined
  if (typeof record.messageId !== 'string' || record.messageId === '') return undefined
  if (record.scope !== 'session' && record.scope !== 'input') return undefined
  return {
    sessionId: record.sessionId,
    messageId: record.messageId,
    mode,
    sessionMode,
    scope: record.scope,
  }
}

export function workModeInputForMessage(
  session: PersistSession | undefined,
  messageId: string,
): WorkModeInputStamp | undefined {
  if (messageId === '') return undefined
  const events = session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== WORK_MODE_INPUT_EVENT) continue
    const parsed = parseWorkModeInputEvent(event.data)
    if (parsed?.messageId === messageId) return parsed
  }
  return undefined
}

export function persistWorkModeInput(session: PersistSession, stamp: WorkModeInputStamp): void {
  try {
    appendIgnorable(session, WORK_MODE_INPUT_EVENT, stamp)
  } catch {
    // Per-input stamps are observational; the in-memory map still owns the live turn.
  }
}

export interface WorkModeChangedData {
  sessionId: string
  from: WorkMode
  to: WorkMode
  summary?: string
  members: Array<{ role: string; phase: string; task?: string }>
}

export function parseWorkModeChangedEvent(data: unknown): WorkModeChangedData | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as {
    sessionId?: unknown
    from?: unknown
    to?: unknown
    summary?: unknown
    members?: unknown
  }
  const from = asWorkMode(record.from)
  const to = asWorkMode(record.to)
  if (from === undefined || to === undefined) return undefined
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return undefined
  const members = Array.isArray(record.members)
    ? record.members.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const member = item as { role?: unknown; phase?: unknown; task?: unknown }
      if (typeof member.role !== 'string' || member.role.trim() === '') return []
      if (typeof member.phase !== 'string' || member.phase.trim() === '') return []
      return [{
        role: member.role.trim(),
        phase: member.phase.trim(),
        ...typeof member.task === 'string' && member.task.trim() !== ''
          ? { task: member.task.trim() }
          : {},
      }]
    })
    : []
  return {
    sessionId: record.sessionId,
    from,
    to,
    ...typeof record.summary === 'string' && record.summary.trim() !== ''
      ? { summary: record.summary.trim() }
      : {},
    members,
  }
}

export function persistWorkModeChanged(session: PersistSession, data: WorkModeChangedData): void {
  try {
    appendIgnorable(session, WORK_MODE_CHANGED_EVENT, data)
  } catch {
    // The mode change itself is already applied; the notice is observational.
  }
}

/** Stamp for the user input of the still-open turn, if any. */
export function latestOpenWorkModeInput(session: PersistSession | undefined): WorkModeInputStamp | undefined {
  const events = session?.snapshotEvents?.() ?? []
  let lastStart = -1
  let lastEnd = -1
  for (let index = 0; index < events.length; index++) {
    const type = events[index]?.type
    if (type === 'turn/start') lastStart = index
    if (type === 'turn/end') lastEnd = index
  }
  if (lastStart <= lastEnd) return undefined
  for (let index = events.length - 1; index > lastStart; index--) {
    const event = events[index]
    if (event?.type !== WORK_MODE_INPUT_EVENT) continue
    const parsed = parseWorkModeInputEvent(event.data)
    if (parsed !== undefined) return parsed
  }
  return undefined
}
