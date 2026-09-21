import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRunPlan, parseDelegateTasks } from '../src/builder.ts'
import {
  CEO_PLAN,
  CEO_PLAN_REVISED,
  CEO_RUN_JOURNAL,
  CEO_RUN_PROCESS,
  appendCeoPlan,
  appendCeoPlanRevision,
  CEO_MEMBER_RESULT,
  appendCeoMemberResult,
  appendRunJournal,
  memberResultsOf,
  appendRunProcess,
  currentTurn,
  journalRuns,
  latestCeoPlan,
  latestCeoRunJournal,
  unknownAfterRestartRuns,
} from '../src/journal.ts'

test('stamps ignorable before freeze so a custom journal type can reload', () => {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = []
  const session = {
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: 1, data }
      Object.freeze(event)
      events.push(event)
      return event
    },
  }
  appendRunJournal(session, {
    turn: 4,
    callId: 'call-1',
    runs: [{
      runId: 'del_1_survey',
      rawId: 'survey',
      role: 'researcher',
      task: 'Survey',
      dependsOn: [],
      phase: 'running',
    }],
  })
  assert.equal(events[0]?.type, CEO_RUN_JOURNAL)
  assert.equal(events[0]?.ignorable, true)
  assert.equal(Object.isFrozen(events[0]), true)
  assert.equal(Object.isExtensible(events[0]!), false)
})

test('reads the open turn and paints missing nodes as queued', () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] },
    ],
  }), 'del_1')
  const session = {
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'turn/start', data: { turn: 4 } },
    ],
  }
  assert.equal(currentTurn(session), 4)
  const runs = journalRuns(plan, new Map([
    [plan.nodes[0]!.runId, { phase: 'running' as const }],
  ]))
  assert.equal(runs[0]?.phase, 'running')
  assert.equal(runs[1]?.phase, 'queued')
})

test('restores the latest plan, preferring a same-turn revision', () => {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = []
  const session = {
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: 1, data }
      Object.freeze(event)
      events.push(event)
      return event
    },
    snapshotEvents: () => events,
  }
  appendCeoPlan(session, {
    turn: 4,
    planId: 'plan_1',
    version: 1,
    summary: 'First split',
    analysis: 'Survey then build',
    tasks: [{ role: 'researcher', task: 'Survey', dependsOn: [] }],
  })
  appendCeoPlanRevision(session, {
    turn: 4,
    planId: 'plan_2',
    version: 2,
    summary: 'Revised split',
    analysis: 'Survey then review',
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey', dependsOn: [] },
      { id: 'review', role: 'reviewer', task: 'Review', dependsOn: ['survey'] },
    ],
  })
  const plan = latestCeoPlan(session)
  assert.equal(plan?.planId, 'plan_2')
  assert.equal(plan?.version, 2)
  assert.equal(plan?.tasks.length, 2)
  assert.equal(events[0]?.type, CEO_PLAN)
  assert.equal(events[1]?.type, CEO_PLAN_REVISED)
  assert.equal(events[1]?.ignorable, true)
})

test('stamps ignorable on a run-process event', () => {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = []
  const session = {
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: 1, data }
      Object.freeze(event)
      events.push(event)
      return event
    },
  }
  appendRunProcess(session, {
    turn: 4,
    callId: 'call-1',
    runId: 'del_1_survey',
    memberId: 'member-1',
    op: { kind: 'reasoning', text: 'search first' },
  })
  assert.equal(events[0]?.type, CEO_RUN_PROCESS)
  assert.equal(events[0]?.ignorable, true)
})

test('indexes the latest member result output by run id', () => {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = []
  const session = {
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: 1, data }
      Object.freeze(event)
      events.push(event)
      return event
    },
    snapshotEvents: () => events,
  }
  appendCeoMemberResult(session, {
    turn: 4,
    callId: 'call-1',
    runId: 'del_1_survey',
    memberId: 'member-1',
    output: 'status: completed\ndone: surveyed A',
    stopReason: 'completed',
    status: 'completed',
  })
  const results = memberResultsOf(session)
  assert.equal(results.get('del_1_survey')?.output, 'status: completed\ndone: surveyed A')
  assert.equal(results.get('del_1_survey')?.memberId, 'member-1')
})

test('rewrites in-flight journal nodes after restart, keeping finished results', () => {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = []
  const session = {
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: 1, data }
      Object.freeze(event)
      events.push(event)
      return event
    },
    snapshotEvents: () => events,
  }
  appendRunJournal(session, {
    turn: 4,
    callId: 'call-1',
    runs: [
      {
        runId: 'del_1_survey',
        rawId: 'survey',
        role: 'researcher',
        task: 'Survey',
        dependsOn: [],
        phase: 'completed',
        memberId: 'member-1',
      },
      {
        runId: 'del_1_build',
        rawId: 'build',
        role: 'implementer',
        task: 'Build',
        dependsOn: ['del_1_survey'],
        phase: 'running',
        memberId: 'member-2',
      },
      {
        runId: 'del_1_review',
        rawId: 'review',
        role: 'reviewer',
        task: 'Review',
        dependsOn: ['del_1_build'],
        phase: 'queued',
      },
    ],
  })
  appendCeoMemberResult(session, {
    turn: 4,
    callId: 'call-1',
    runId: 'del_1_survey',
    memberId: 'member-1',
    output: 'status: completed\ndone: surveyed',
    stopReason: 'completed',
    status: 'completed',
  })
  const journal = latestCeoRunJournal(session)
  assert.ok(journal)
  const { runs, changed } = unknownAfterRestartRuns(journal, session)
  assert.equal(changed, true)
  assert.equal(runs[0]?.phase, 'completed')
  assert.equal(runs[1]?.phase, 'unknown_after_restart')
  assert.equal(runs[2]?.phase, 'queued')
  assert.equal(events.some(event => event.type === CEO_MEMBER_RESULT), true)
})
