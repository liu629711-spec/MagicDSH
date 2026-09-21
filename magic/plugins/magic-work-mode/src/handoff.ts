import type { PersistSession } from './persist.ts'
import type { WorkMode } from './mode.ts'

const CEO_PLAN = 'ceo/plan'
const CEO_PLAN_REVISED = 'ceo/plan-revised'
const CEO_RUN_JOURNAL = 'ceo/run-journal'

const OPEN = new Set([
  'queued',
  'running',
  'blocked',
  'unverified',
  'unknown_after_restart',
  'failed',
  'cancelled',
])

export const WORK_MODE_CONFIRM_PREFIX = 'Work mode change needs confirmation.'

export function isWorkModeConfirmText(text: string): boolean {
  return text.startsWith(WORK_MODE_CONFIRM_PREFIX)
}

export interface WorkModeHandoffMember {
  role: string
  phase: string
  task?: string
}

export interface WorkModeHandoff {
  summary?: string
  members: WorkModeHandoffMember[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function journalMembers(data: unknown): WorkModeHandoffMember[] {
  if (!isRecord(data) || !Array.isArray(data.runs)) return []
  return data.runs.flatMap((item) => {
    if (!isRecord(item) || typeof item.role !== 'string' || item.role.trim() === '') return []
    const phase = typeof item.phase === 'string' && item.phase.trim() !== ''
      ? item.phase.trim()
      : 'queued'
    const task = typeof item.task === 'string' && item.task.trim() !== ''
      ? item.task.trim()
      : undefined
    return [{
      role: item.role.trim(),
      phase,
      ...task === undefined ? {} : { task },
    }]
  })
}

/** Snapshot of the latest CEO plan/journal on this session. */
export function workModeHandoffOf(session: PersistSession | undefined): WorkModeHandoff {
  const events = session?.snapshotEvents?.() ?? []
  let summary: string | undefined
  let members: WorkModeHandoffMember[] = []
  for (const event of events) {
    if (event?.type === CEO_PLAN || event?.type === CEO_PLAN_REVISED) {
      const data = isRecord(event.data) ? event.data : undefined
      if (typeof data?.summary === 'string' && data.summary.trim() !== '') {
        summary = data.summary.trim()
      }
    }
    if (event?.type === CEO_RUN_JOURNAL) {
      const parsed = journalMembers(event.data)
      if (parsed.length > 0) members = parsed
    }
  }
  return summary === undefined ? { members } : { summary, members }
}

export function needsWorkModeConfirm(handoff: WorkModeHandoff): boolean {
  if (handoff.members.some(member => OPEN.has(member.phase))) return true
  return handoff.members.length === 0 && (handoff.summary ?? '') !== ''
}

export function describeWorkModeConfirm(
  handoff: WorkModeHandoff,
  from: WorkMode,
  to: WorkMode,
): string {
  const fromLabel = from === 'ceo' ? 'CEO' : 'agent'
  const toLabel = to === 'ceo' ? 'CEO' : 'agent'
  const lines = [
    WORK_MODE_CONFIRM_PREFIX,
    `Current work mode: ${fromLabel}. Next session default would be ${toLabel}.`,
  ]
  if (handoff.summary !== undefined) lines.push(`Goal: ${handoff.summary}`)
  if (handoff.members.length > 0) {
    lines.push('Members:')
    for (const member of handoff.members) {
      const task = member.task === undefined ? '' : ` ${member.task}`
      lines.push(`- ${member.role} [${member.phase}]${task}`)
    }
  } else {
    lines.push('A CEO plan is recorded but no members have started.')
  }
  lines.push(`Use /mode ${to} confirm to continue.`)
  return lines.join('\n')
}
