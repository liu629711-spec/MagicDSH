import {
  parseWorkModeChangedEvent,
  parseWorkModeClientEvent,
  WORK_MODE_CHANGED_EVENT,
  WORK_MODE_EVENT,
  type WorkModeChangedData,
} from '../persist.ts'
import { applyClientWorkModeState } from './state.ts'

export const workModeEventDefinition = {
  kind: 'magic-work-mode',
  match: (event: { type?: string; seq?: number; data?: unknown }) => {
    if (event.type !== WORK_MODE_EVENT) return null
    if (parseWorkModeClientEvent(event.data) === undefined) return null
    return { id: String(event.seq), role: 'start' as const }
  },
  start: (_context: unknown, match: { event: { data?: unknown } }) => {
    const parsed = parseWorkModeClientEvent(match.event.data)
    if (parsed !== undefined) applyClientWorkModeState(parsed.sessionId, parsed.state)
    return parsed
  },
  update: (context: { state: unknown }) => context.state,
}

export const workModeChangedDefinition = {
  kind: 'magic-work-mode-changed',
  target: 'chat',
  match: (event: { type?: string; seq?: number; data?: unknown }) => {
    if (event.type !== WORK_MODE_CHANGED_EVENT) return null
    if (parseWorkModeChangedEvent(event.data) === undefined) return null
    return { id: String(event.seq), role: 'start' as const }
  },
  start: (_context: unknown, match: { event: { data?: unknown } }) => {
    return parseWorkModeChangedEvent(match.event.data)
  },
  update: (context: { state: unknown }) => context.state,
  buildViewNode: (context: {
    key: string
    id: string
    state: WorkModeChangedData | undefined
    start?: { event: { seq: number }; location: unknown }
  }) => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'magic-work-mode-changed',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
