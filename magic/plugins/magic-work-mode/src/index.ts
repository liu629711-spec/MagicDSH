export const name = 'magic-work-mode'

export const inject = ['systemPrompt', 'commands']

export type { MagicWorkModeState, WorkMode } from './mode.ts'
export {
  applyModeCommand,
  describeMode,
  parseModeCommand,
  resolveMode,
} from './mode.ts'

import {
  applyModeCommand,
  clearInputMode,
  defaultWorkModeState,
  describeMode,
  MODE_COMMAND_ERROR,
  parseModeCommand,
  resolveMode,
  type MagicWorkModeState,
  type WorkMode,
} from './mode.ts'
import {
  describeWorkModeConfirm,
  needsWorkModeConfirm,
  workModeHandoffOf,
} from './handoff.ts'
import {
  latestWorkModeRecord,
  parseWorkModeClientEvent,
  persistWorkMode,
  persistWorkModeChanged,
  latestOpenWorkModeInput,
  persistWorkModeInput,
  workModeInputForMessage,
  type PersistSession,
} from './persist.ts'

export {
  WORK_MODE_EVENT,
  WORK_MODE_INPUT_EVENT,
  WORK_MODE_CHANGED_EVENT,
  latestWorkMode,
  persistWorkMode,
  persistWorkModeInput,
  persistWorkModeChanged,
  workModeInputForMessage,
} from './persist.ts'
export {
  describeWorkModeConfirm,
  isWorkModeConfirmText,
  needsWorkModeConfirm,
  workModeHandoffOf,
  WORK_MODE_CONFIRM_PREFIX,
} from './handoff.ts'

const sessionModes = new Map<string, MagicWorkModeState>()
const inputStamps = new Map<string, WorkMode>()
const claimedBySession = new Map<string, string>()

function stampKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`
}

type PromptAssembleContext = {
  agent?: { session?: { id?: string } }
}

function sessionOf(context: PromptAssembleContext | undefined): (PersistSession & { id?: string }) | undefined {
  const session = context?.agent?.session
  if (session === undefined || typeof session !== 'object') return undefined
  return session as PersistSession & { id?: string }
}

function sessionIdOf(context: PromptAssembleContext | undefined): string | undefined {
  const id = sessionOf(context)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function hydrate(sessionId: string, session?: PersistSession): MagicWorkModeState {
  const cached = sessionModes.get(sessionId)
  if (cached !== undefined) return cached
  const restored = latestWorkModeRecord(session)
  if (restored !== undefined) {
    sessionModes.set(sessionId, restored.state)
    if (session !== undefined && parseWorkModeClientEvent(restored.data) === undefined) {
      persistWorkMode(session, restored.state, sessionId)
    }
    return restored.state
  }
  if (session === undefined) return defaultWorkModeState()
  const fallback = defaultWorkModeState()
  sessionModes.set(sessionId, fallback)
  return fallback
}

function stateOf(sessionId: string, session?: PersistSession): MagicWorkModeState {
  return hydrate(sessionId, session)
}

export function workModePrompt(mode: WorkMode): string {
  if (mode === 'ceo') {
    return [
      'Magic work-mode rules:',
      '- Current work mode: CEO. This session (or this input) is already CEO. Do not behave as a solo agent.',
      '- You are the session lead: divide work, track dependencies, report blockers, and deliver one result.',
      '- Members are working agents, not reduced tools.',
    ].join('\n')
  }
  return [
    'Magic work-mode rules:',
    '- Current work mode: agent.',
    '- Default to agent mode. Do not upgrade to CEO because a task is large, slow, or uses extra agents.',
    '- Enter CEO only when the user explicitly asks for CEO or the session default is CEO.',
    '- A once-CEO choice applies only to the current input. After that input is queued, return to the session default.',
    '- CEO organizes work packages and reports a single result. It is not a permanent organization.',
  ].join('\n')
}

function modeForMessage(sessionId: string, messageId: string, session?: PersistSession): WorkMode | undefined {
  const cached = inputStamps.get(stampKey(sessionId, messageId))
  if (cached !== undefined) return cached
  return workModeInputForMessage(session, messageId)?.mode
}

function userInsertsOf(event: { type?: string; data?: unknown }): Array<{ id: string }> {
  if (event.type !== 'agent/inbox/spliced') return []
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return []
  const data = event.data as { inserted?: unknown; outcome?: unknown }
  if (data.outcome === 'canceled' || !Array.isArray(data.inserted)) return []
  return data.inserted.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const message = item as { id?: unknown; source?: { kind?: unknown } }
    if (message.source?.kind !== 'user') return []
    if (typeof message.id !== 'string' || message.id === '') return []
    return [{ id: message.id }]
  })
}

function stampUserInserts(session: PersistSession & { id: string }, inserts: Array<{ id: string }>): void {
  if (inserts.length === 0) return
  let current = stateOf(session.id, session)
  for (const insert of inserts) {
    const key = stampKey(session.id, insert.id)
    if (inputStamps.has(key) || workModeInputForMessage(session, insert.id) !== undefined) continue
    const mode = resolveMode(current)
    const stamp = {
      sessionId: session.id,
      messageId: insert.id,
      mode,
      sessionMode: current.sessionMode,
      scope: current.inputMode === null ? 'session' as const : 'input' as const,
    }
    inputStamps.set(key, mode)
    persistWorkModeInput(session, stamp)
    if (current.inputMode !== null) {
      current = clearInputMode(current)
      sessionModes.set(session.id, current)
      persistWorkMode(session, current, session.id)
    }
  }
}

export function getSessionWorkMode(sessionId: string, session?: PersistSession): WorkMode {
  const claimed = claimedBySession.get(sessionId)
  if (claimed !== undefined) {
    const pinned = modeForMessage(sessionId, claimed, session)
    if (pinned !== undefined) return pinned
  }
  const open = latestOpenWorkModeInput(session)
  if (open !== undefined) return open.mode
  return resolveMode(hydrate(sessionId, session))
}

export function getSessionWorkModeState(sessionId: string, session?: PersistSession): MagicWorkModeState {
  return stateOf(sessionId, session)
}

export function apply(ctx: {
  provide?: (name: string, value: unknown) => unknown
  on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown
  systemPrompt: {
    section: (section: {
      name: string
      order: number
      text: string | ((context?: PromptAssembleContext) => string)
    }) => unknown
  }
  commands: {
    register: (definition: {
      name: string
      description: string
      input?: { hint: string }
      handler: (invocation: { agent: { session: PersistSession & { id: string } }; rawInput: string }) => { kind: 'success' | 'error'; text: string }
    }) => unknown
  }
}) {
  console.log('[magic-work-mode] plugin loaded')

  ctx.provide?.('magicWorkMode', {
    getMode: getSessionWorkMode,
    getState: getSessionWorkModeState,
  })

  ctx.on?.('session/event', (session, event) => {
    const subject = session as PersistSession & { id?: string }
    const payload = event as { type?: string; data?: unknown }
    if (typeof subject.id !== 'string') return
    if (!sessionModes.has(subject.id)) hydrate(subject.id, subject)
    stampUserInserts(subject as PersistSession & { id: string }, userInsertsOf(payload))
    if (payload.type === 'turn/end') claimedBySession.delete(subject.id)
  })

  ctx.on?.('agent/inbox/claimed', (payload) => {
    const record = payload as { agent?: { session?: { id?: string } }; message?: { id?: unknown } }
    const sessionId = record.agent?.session?.id
    const messageId = record.message?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof messageId !== 'string' || messageId === '') return
    claimedBySession.set(sessionId, messageId)
  })

  ctx.systemPrompt.section({
    name: 'magic-work-mode',
    order: 250,
    text: (context) => {
      const session = sessionOf(context)
      const sessionId = sessionIdOf(context)
      const mode = sessionId === undefined ? 'agent' : getSessionWorkMode(sessionId, session)
      return workModePrompt(mode)
    },
  })

  ctx.commands.register({
    name: 'mode',
    description: 'Show or set the Magic work mode for this session or this input',
    input: { hint: '[agent|ceo|once agent|once ceo]' },
    handler: ({ agent, rawInput }) => {
      const sessionId = agent.session.id
      const current = stateOf(sessionId, agent.session)
      const command = parseModeCommand(rawInput)

      if (command.kind === 'show') {
        return {
          kind: 'success',
          text: describeMode(current),
        }
      }

      if (command.kind === 'invalid') {
        return {
          kind: 'error',
          text: MODE_COMMAND_ERROR,
        }
      }

      if (command.kind === 'session' && command.mode !== current.sessionMode) {
        const handoff = workModeHandoffOf(agent.session)
        if (needsWorkModeConfirm(handoff) && command.confirmed !== true) {
          return {
            kind: 'error',
            text: describeWorkModeConfirm(handoff, current.sessionMode, command.mode),
          }
        }
        if (handoff.members.length > 0 || handoff.summary !== undefined) {
          persistWorkModeChanged(agent.session, {
            sessionId,
            from: current.sessionMode,
            to: command.mode,
            ...handoff.summary === undefined ? {} : { summary: handoff.summary },
            members: handoff.members,
          })
        }
      }

      const next = applyModeCommand(current, command)
      sessionModes.set(sessionId, next)
      persistWorkMode(agent.session, next)
      return {
        kind: 'success',
        text: describeMode(next),
      }
    },
  })
}

export function resetWorkModeStateForTests(): void {
  sessionModes.clear()
  inputStamps.clear()
  claimedBySession.clear()
}
