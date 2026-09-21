export type WorkMode = 'agent' | 'ceo'

export interface MagicWorkModeState {
  sessionMode: WorkMode
  inputMode: WorkMode | null
}

export type ModeCommand =
  | { kind: 'show' }
  | { kind: 'session'; mode: WorkMode; confirmed: boolean }
  | { kind: 'once'; mode: WorkMode }
  | { kind: 'once-clear' }
  | { kind: 'invalid' }

export function defaultWorkModeState(): MagicWorkModeState {
  return { sessionMode: 'agent', inputMode: null }
}

export function parseWorkMode(value: string): WorkMode | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'agent' || normalized === 'ceo') return normalized
  return null
}

export function parseModeCommand(rawInput: string): ModeCommand {
  const value = rawInput.trim().toLowerCase()
  if (value === '') return { kind: 'show' }
  const confirmed = value.endsWith(' confirm')
  const rest = confirmed ? value.slice(0, -8).trim() : value
  if (rest === 'once' || rest === 'once off' || rest === 'once clear') {
    return confirmed ? { kind: 'invalid' } : { kind: 'once-clear' }
  }
  if (rest.startsWith('once ')) {
    if (confirmed) return { kind: 'invalid' }
    const mode = parseWorkMode(rest.slice(5))
    if (mode === null) return { kind: 'invalid' }
    return { kind: 'once', mode }
  }
  const mode = parseWorkMode(rest)
  if (mode === null) return { kind: 'invalid' }
  return { kind: 'session', mode, confirmed }
}

export function resolveMode(state: MagicWorkModeState | undefined): WorkMode {
  return state?.inputMode ?? state?.sessionMode ?? 'agent'
}

export function applyModeCommand(
  state: MagicWorkModeState,
  command: ModeCommand,
): MagicWorkModeState {
  if (command.kind === 'session') {
    return { sessionMode: command.mode, inputMode: null }
  }
  if (command.kind === 'once') return { sessionMode: state.sessionMode, inputMode: command.mode }
  if (command.kind === 'once-clear') return { sessionMode: state.sessionMode, inputMode: null }
  return state
}

export function clearInputMode(state: MagicWorkModeState): MagicWorkModeState {
  if (state.inputMode === null) return state
  return { sessionMode: state.sessionMode, inputMode: null }
}

function modeLabel(mode: WorkMode): string {
  return mode === 'ceo' ? 'CEO' : 'agent'
}

function explainMode(mode: WorkMode): string[] {
  if (mode === 'ceo') {
    return [
      'The session lead owns division of labor, dependencies, reporting, blockers, and a single delivery.',
      'Members are working agents, not reduced tools.',
    ]
  }
  return [
    'The session lead understands, plans, executes, verifies, and delivers the user goal.',
    'Internal collaborators stay inside this session and do not become long-lived members.',
  ]
}

export function describeMode(state: MagicWorkModeState): string {
  const header = state.inputMode !== null
    ? [
      `Current work mode: ${modeLabel(state.inputMode)} for this input only.`,
      `Session default remains ${modeLabel(state.sessionMode)}.`,
    ]
    : [
      `Current work mode: ${modeLabel(state.sessionMode)}.`,
      'This is the session default.',
    ]
  return [...header, ...explainMode(resolveMode(state))].join('\n')
}

export const MODE_COMMAND_ERROR =
  'Use `/mode`, `/mode agent`, `/mode ceo`, or `/mode once ceo`.'

export function parseDescribedMode(text: string): MagicWorkModeState | null {
  const once = /Current work mode: (CEO|agent) for this input only\.\nSession default remains (CEO|agent)\./i.exec(text)
  if (once?.[1] !== undefined && once[2] !== undefined) {
    return {
      sessionMode: once[2].toLowerCase() as WorkMode,
      inputMode: once[1].toLowerCase() as WorkMode,
    }
  }
  const session = /Current work mode: (CEO|agent)\.\nThis is the session default\./i.exec(text)
  if (session?.[1] !== undefined) {
    return { sessionMode: session[1].toLowerCase() as WorkMode, inputMode: null }
  }
  return null
}
