import type { RunPhase, RunPlan, RunState } from './plan.ts'

export const CEO_RUN_JOURNAL = 'ceo/run-journal'
export const CEO_PLAN = 'ceo/plan'
export const CEO_PLAN_REVISED = 'ceo/plan-revised'
export const CEO_RUN_PHASE = 'ceo/run-phase'
export const CEO_RUN_PROGRESS = 'ceo/run-progress'
export const CEO_RUN_PROCESS = 'ceo/run-process'
export const CEO_MEMBER_RESULT = 'ceo/member-result'
export const CEO_MEMBER_USAGE = 'ceo/member-usage'
export const CEO_MEMBER_HALTED = 'ceo/member-halted'
export const CEO_MEMBER_REDIRECTED = 'ceo/member-redirected'
export const CEO_CHECKPOINT = 'ceo/checkpoint'

export interface CeoPlanTask {
  id?: string
  role: string
  task: string
  dependsOn: string[]
  bindAfterDeps?: boolean
}

export interface CeoPlanData {
  turn: number
  planId: string
  version: number
  summary: string
  analysis: string
  teamBrief?: string
  tasks: CeoPlanTask[]
}

export interface CeoRunPhaseData {
  turn: number
  callId: string
  runId: string
  memberId: string
  phase: 'thinking' | 'tool' | 'waiting' | 'winding_down'
  toolName?: string
}

export interface CeoRunProgressData {
  turn: number
  callId: string
  completed: number
  total: number
}

export interface CeoRunJournalRun {
  runId: string
  rawId: string
  role: string
  task: string
  dependsOn: string[]
  phase: RunPhase
  memberId?: string
  bindAfterDeps?: boolean
}

export interface CeoRunJournalData {
  turn: number
  callId: string
  runs: CeoRunJournalRun[]
}

export interface JournalSession {
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

/**
 * DSH `Session.append` does not put `ignorable` on the envelope
 * (`reference-project/deepseek-harness/packages/core/session/src/index.ts` L668-697).
 * Out-of-repo event types are refused on reload unless the stored record has
 * `ignorable: true` (`session-persistence/src/coordinator.ts` L1248-1251).
 * Stamp the marker before `deepFreeze` seals the object.
 */
function appendIgnorable(session: JournalSession, type: string, data: unknown): void {
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

function eventData(event: { data?: unknown } | undefined): Record<string, unknown> | undefined {
  const data = event?.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return data as Record<string, unknown>
}

export function currentTurn(session: JournalSession): number | undefined {
  const events = session.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    const data = eventData(event)
    if (event?.type === 'turn/start' && typeof data?.turn === 'number') {
      return data.turn
    }
  }
  return undefined
}

function asPlanTask(value: unknown): CeoPlanTask | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as { id?: unknown; role?: unknown; task?: unknown; dependsOn?: unknown; bindAfterDeps?: unknown }
  if (typeof item.role !== 'string' || item.role.trim() === '') return undefined
  if (typeof item.task !== 'string' || item.task.trim() === '') return undefined
  return {
    ...typeof item.id === 'string' && item.id.trim() !== '' ? { id: item.id.trim() } : {},
    role: item.role.trim(),
    task: item.task.trim(),
    dependsOn: Array.isArray(item.dependsOn)
      ? item.dependsOn.filter((dep): dep is string => typeof dep === 'string' && dep.trim() !== '').map(dep => dep.trim())
      : [],
    ...item.bindAfterDeps === true ? { bindAfterDeps: true } : {},
  }
}

export function parseCeoPlanData(data: unknown): CeoPlanData | undefined {
  const record = eventData({ data })
  if (record === undefined) return undefined
  if (typeof record.turn !== 'number') return undefined
  if (typeof record.planId !== 'string' || record.planId.trim() === '') return undefined
  if (typeof record.version !== 'number') return undefined
  if (typeof record.summary !== 'string' || record.summary.trim() === '') return undefined
  if (typeof record.analysis !== 'string' || record.analysis.trim() === '') return undefined
  if (!Array.isArray(record.tasks)) return undefined
  const tasks = record.tasks.flatMap(item => {
    const task = asPlanTask(item)
    return task === undefined ? [] : [task]
  })
  if (tasks.length === 0) return undefined
  return {
    turn: record.turn,
    planId: record.planId.trim(),
    version: record.version,
    summary: record.summary.trim(),
    analysis: record.analysis.trim(),
    ...typeof record.teamBrief === 'string' && record.teamBrief.trim() !== ''
      ? { teamBrief: record.teamBrief.trim() }
      : {},
    tasks,
  }
}

const RUN_PHASES = new Set<RunPhase>([
  'queued',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
  'unverified',
  'unknown_after_restart',
  'blocked',
])

function asJournalRun(value: unknown): CeoRunJournalRun | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as {
    runId?: unknown
    rawId?: unknown
    role?: unknown
    task?: unknown
    dependsOn?: unknown
    phase?: unknown
    memberId?: unknown
    bindAfterDeps?: unknown
  }
  if (typeof item.role !== 'string' || item.role.trim() === '') return undefined
  if (typeof item.task !== 'string' || item.task.trim() === '') return undefined
  const rawId = typeof item.rawId === 'string' && item.rawId.trim() !== ''
    ? item.rawId.trim()
    : typeof item.runId === 'string' && item.runId.trim() !== ''
      ? item.runId.trim()
      : undefined
  if (rawId === undefined) return undefined
  const runId = typeof item.runId === 'string' && item.runId.trim() !== '' ? item.runId.trim() : rawId
  const phase = typeof item.phase === 'string' && RUN_PHASES.has(item.phase as RunPhase)
    ? item.phase as RunPhase
    : 'queued'
  return {
    runId,
    rawId,
    role: item.role.trim(),
    task: item.task.trim(),
    dependsOn: Array.isArray(item.dependsOn)
      ? item.dependsOn.filter((dep): dep is string => typeof dep === 'string' && dep.trim() !== '').map(dep => dep.trim())
      : [],
    phase,
    ...typeof item.memberId === 'string' && item.memberId.trim() !== ''
      ? { memberId: item.memberId.trim() }
      : {},
    ...item.bindAfterDeps === true ? { bindAfterDeps: true } : {},
  }
}

export function parseCeoRunJournalData(data: unknown): CeoRunJournalData | undefined {
  const record = eventData({ data })
  if (record === undefined) return undefined
  if (typeof record.turn !== 'number') return undefined
  if (typeof record.callId !== 'string' || record.callId.trim() === '') return undefined
  if (!Array.isArray(record.runs)) return undefined
  const runs = record.runs.flatMap(item => {
    const run = asJournalRun(item)
    return run === undefined ? [] : [run]
  })
  if (runs.length === 0) return undefined
  return { turn: record.turn, callId: record.callId.trim(), runs }
}

/** Latest ceo/run-journal snapshot, used to freeze in-flight members after restart. */
export function latestCeoRunJournal(session: JournalSession | undefined): CeoRunJournalData | undefined {
  const events = session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== CEO_RUN_JOURNAL) continue
    const parsed = parseCeoRunJournalData(event.data)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

const LOST_IN_FLIGHT = new Set<RunPhase>(['running'])

function memberResultKeys(session: JournalSession | undefined): Set<string> {
  const keys = new Set<string>()
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event?.type !== CEO_MEMBER_RESULT) continue
    const data = eventData(event)
    if (typeof data?.runId === 'string' && data.runId.trim() !== '') keys.add(data.runId.trim())
    if (typeof data?.memberId === 'string' && data.memberId.trim() !== '') keys.add(data.memberId.trim())
  }
  return keys
}

/**
 * Rewrite running nodes that never recorded ceo/member-result.
 * Queued and blocked nodes stay as they are so ceo_replan can redispatch them.
 * Does not resume the scheduler. Does not reuse unverified.
 */
export function unknownAfterRestartRuns(
  journal: CeoRunJournalData,
  session: JournalSession | undefined,
): { runs: CeoRunJournalRun[]; changed: boolean } {
  const results = memberResultKeys(session)
  let changed = false
  const runs = journal.runs.map((run) => {
    if (!LOST_IN_FLIGHT.has(run.phase)) return run
    if (results.has(run.runId) || (run.memberId !== undefined && results.has(run.memberId))) {
      return run
    }
    changed = true
    return { ...run, phase: 'unknown_after_restart' as const }
  })
  return { runs, changed }
}

/** Latest worker output per run_id, used to restore upstream text after restart. */
export function memberResultsOf(session: JournalSession | undefined): Map<string, { output: string; memberId?: string }> {
  const results = new Map<string, { output: string; memberId?: string }>()
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event?.type !== CEO_MEMBER_RESULT) continue
    const data = eventData(event)
    if (data === undefined) continue
    const runId = typeof data.runId === 'string' ? data.runId.trim() : ''
    const output = typeof data.output === 'string' ? data.output : ''
    if (runId === '') continue
    const memberId = typeof data.memberId === 'string' && data.memberId.trim() !== ''
      ? data.memberId.trim()
      : undefined
    results.set(runId, memberId === undefined ? { output } : { output, memberId })
  }
  return results
}

/** Latest ceo_plan / ceo_plan-revised on this session, used to restore the plan gate after restart. */
export function latestCeoPlan(session: JournalSession | undefined): CeoPlanData | undefined {
  const events = session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== CEO_PLAN && event?.type !== CEO_PLAN_REVISED) continue
    const parsed = parseCeoPlanData(event.data)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export function journalRuns(
  plan: RunPlan,
  phases: ReadonlyMap<string, RunState>,
): CeoRunJournalRun[] {
  return plan.nodes.map(node => {
    const state = phases.get(node.runId)
    return {
      runId: node.runId,
      rawId: node.rawId,
      role: node.role,
      task: node.task,
      dependsOn: node.dependsOn,
      phase: state?.phase ?? 'queued',
      ...state?.memberId === undefined ? {} : { memberId: state.memberId },
      ...node.bindAfterDeps === true ? { bindAfterDeps: true } : {},
    }
  })
}

export function appendRunJournal(
  session: JournalSession,
  data: CeoRunJournalData,
): void {
  try {
    appendIgnorable(session, CEO_RUN_JOURNAL, data)
  } catch {
    // Live journal must not fail the delegate.
  }
}

/** Persist the CEO's pre-delegation plan as an ignorable session event. */
export function appendCeoPlan(session: JournalSession, data: CeoPlanData): void {
  try {
    appendIgnorable(session, CEO_PLAN, data)
  } catch {
    // Planning is useful context; it must not make delegation fail.
  }
}

/** Persist a replacement plan separately so replay can retain prior versions. */
export function appendCeoPlanRevision(session: JournalSession, data: CeoPlanData): void {
  try {
    appendIgnorable(session, CEO_PLAN_REVISED, data)
  } catch {
    // A revision is explanatory state and must not interrupt planning.
  }
}

/** Persist the worker's current activity; lifecycle state remains in ceo/run-journal. */
export function appendCeoRunPhase(session: JournalSession, data: CeoRunPhaseData): void {
  try {
    appendIgnorable(session, CEO_RUN_PHASE, data)
  } catch {
    // Activity indicators are observational.
  }
}

/** Persist a deterministic scheduler progress snapshot for live and replay views. */
export function appendCeoRunProgress(session: JournalSession, data: CeoRunProgressData): void {
  try {
    appendIgnorable(session, CEO_RUN_PROGRESS, data)
  } catch {
    // Progress must not affect scheduling.
  }
}

export interface CeoSearchSource {
  url: string
  title?: string
  snippet?: string
}

export type CeoProcessOp =
  | { kind: 'reasoning'; text: string }
  | { kind: 'content'; text: string }
  | { kind: 'tool-start'; toolCallId: string; name: string; args?: string }
  | { kind: 'tool-end'; toolCallId: string; result?: string; isError?: boolean; sources?: CeoSearchSource[] }

export interface CeoRunProcessData {
  turn: number
  callId: string
  runId: string
  memberId: string
  op: CeoProcessOp
}

export interface CeoMemberResultData {
  turn: number
  callId: string
  runId: string
  memberId: string
  output: string
  stopReason: string
  status?: 'completed' | 'blocked' | 'failed' | 'partial' | 'unverified' | 'unknown_after_restart'
}

/** Cumulative token accounting for one member session (DSH assistant/message usage). */
export interface CeoTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface CeoMemberUsageData {
  turn: number
  callId: string
  runId: string
  memberId: string
  usage: CeoTokenUsage
}

export interface CeoContextChannel {
  channel: string
  chars: number
  truncated: boolean
}

/** Provenance of what one member was fed: channel name + size + lossiness. */
export interface CeoMemberContextData {
  turn: number
  callId: string
  runId: string
  memberId: string
  channels: CeoContextChannel[]
}

export type CeoHaltReason = 'user_stop'

export interface CeoMemberHaltedData {
  turn: number
  callId: string
  runId: string
  memberId: string
  reason: CeoHaltReason
}

export interface CeoMemberRedirectedData {
  turn: number
  callId: string
  runId: string
  memberId?: string
  note: string
}

export type CeoCheckpointKind = 'decision' | 'unknown_after_restart'

export interface CeoCheckpointData {
  turn: number
  callId: string
  kind: CeoCheckpointKind
  runId?: string
  memberId?: string
  question?: string
  note: string
  resolvedAt?: number
}

/** Persist one member's cumulative token usage; observational, never gates scheduling. */
export function appendCeoMemberUsage(session: JournalSession, data: CeoMemberUsageData): void {
  try {
    appendIgnorable(session, CEO_MEMBER_USAGE, data)
  } catch {
    // Usage is observational.
  }
}

/** Persist the provenance channels one member's prompt carried. */
export function appendCeoMemberContext(session: JournalSession, data: CeoMemberContextData): void {
  try {
    appendIgnorable(session, 'ceo/member-context', data)
  } catch {
    // Provenance projection is observational.
  }
}

export function appendCeoMemberHalted(session: JournalSession, data: CeoMemberHaltedData): void {
  try {
    appendIgnorable(session, CEO_MEMBER_HALTED, data)
  } catch {
    // Halt bookkeeping must not fail the stop itself.
  }
}

export function appendCeoMemberRedirected(session: JournalSession, data: CeoMemberRedirectedData): void {
  try {
    appendIgnorable(session, CEO_MEMBER_REDIRECTED, data)
  } catch {
    // Redirect bookkeeping must not fail the redirect itself.
  }
}

export function appendCeoCheckpoint(session: JournalSession, data: CeoCheckpointData): void {
  try {
    appendIgnorable(session, CEO_CHECKPOINT, data)
  } catch {
    // Checkpoint projection is observational.
  }
}

export function ceoCheckpointsOf(session: JournalSession | undefined): CeoCheckpointData[] {
  const checkpoints: CeoCheckpointData[] = []
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event?.type !== CEO_CHECKPOINT) continue
    const data = eventData(event)
    if (data === undefined || typeof data.turn !== 'number' || typeof data.callId !== 'string') continue
    if (data.kind !== 'decision' && data.kind !== 'unknown_after_restart') continue
    checkpoints.push({
      turn: data.turn,
      callId: data.callId,
      kind: data.kind,
      ...typeof data.runId === 'string' && data.runId.trim() !== '' ? { runId: data.runId.trim() } : {},
      ...typeof data.memberId === 'string' && data.memberId.trim() !== '' ? { memberId: data.memberId.trim() } : {},
      ...typeof data.question === 'string' && data.question.trim() !== '' ? { question: data.question.trim() } : {},
      note: typeof data.note === 'string' && data.note.trim() !== '' ? data.note.trim() : '',
      ...typeof data.resolvedAt === 'number' ? { resolvedAt: data.resolvedAt } : {},
    })
  }
  return checkpoints
}

/** Persist the worker's final output independently of send_message delivery. */
export function appendCeoMemberResult(session: JournalSession, data: CeoMemberResultData): void {
  try {
    appendIgnorable(session, CEO_MEMBER_RESULT, data)
  } catch {
    // Result projection is observational; the scheduler still owns execution truth.
  }
}

export function appendRunProcess(
  session: JournalSession,
  data: CeoRunProcessData,
): void {
  try {
    appendIgnorable(session, CEO_RUN_PROCESS, data)
  } catch {
    // Live process must not fail the delegate.
  }
}
