import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apply,
  getSessionWorkMode,
  getSessionWorkModeState,
  resetWorkModeStateForTests,
  WORK_MODE_CHANGED_EVENT,
  WORK_MODE_CONFIRM_PREFIX,
  WORK_MODE_EVENT,
} from '../src/index.ts'
import {
  applyModeCommand,
  describeMode,
  parseDescribedMode,
  parseModeCommand,
  resolveMode,
} from '../src/mode.ts'

test('registers a prompt section and /mode command', () => {
  resetWorkModeStateForTests()

  const sections: Array<{
    name: string
    order: number
    text: string | ((context?: { agent?: { session?: { id?: string } } }) => string)
  }> = []
  const commands: Array<{ name: string; handler: Function }> = []
  const provided: Array<{ name: string; value: unknown }> = []

  apply({
    provide: (name, value) => {
      provided.push({ name, value })
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
      },
    },
    commands: {
      register: (definition) => {
        commands.push(definition)
      },
    },
  })

  assert.equal(sections[0]?.name, 'magic-work-mode')
  assert.equal(commands[0]?.name, 'mode')
  assert.equal(provided[0]?.name, 'magicWorkMode')
  const text = typeof sections[0]?.text === 'function' ? sections[0].text() : ''
  assert.match(text, /once-CEO/)
  assert.match(text, /Current work mode: agent/)
})

test('defaults to agent and can switch the session to CEO', () => {
  resetWorkModeStateForTests()

  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined

  apply({
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })

  assert.ok(handler)
  const agent = { session: { id: 'session-1' } }

  const shown = handler({ agent, rawInput: '' })
  assert.equal(shown.kind, 'success')
  assert.match(shown.text, /agent/i)
  assert.match(shown.text, /session default/i)

  const switched = handler({ agent, rawInput: 'ceo' })
  assert.equal(switched.kind, 'success')
  assert.match(switched.text, /CEO/)
  assert.equal(getSessionWorkMode('session-1'), 'ceo')
  assert.deepEqual(getSessionWorkModeState('session-1'), { sessionMode: 'ceo', inputMode: null })

  const invalid = handler({ agent, rawInput: 'team' })
  assert.equal(invalid.kind, 'error')
})

test('CEO session prompt states current mode and does not keep the agent default', () => {
  resetWorkModeStateForTests()

  const sections: Array<{
    name: string
    text: string | ((context?: { agent?: { session?: { id?: string } } }) => string)
  }> = []
  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined

  apply({
    systemPrompt: {
      section: (section) => {
        sections.push(section)
      },
    },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })

  assert.ok(handler)
  handler({ agent: { session: { id: 'session-ceo' } }, rawInput: 'ceo' })

  const textFn = sections[0]?.text
  assert.equal(typeof textFn, 'function')
  const callText = textFn as (context?: unknown) => string
  const ceoText = callText({ agent: { session: { id: 'session-ceo' } } })
  assert.match(ceoText, /Current work mode: CEO/)
  assert.match(ceoText, /already CEO/)
  assert.doesNotMatch(ceoText, /Default to agent mode/)

  const agentText = callText({ agent: { session: { id: 'session-other' } } })
  assert.match(agentText, /Current work mode: agent/)
  assert.match(agentText, /Default to agent mode/)
})

test('once CEO applies only until the current input is queued', () => {
  resetWorkModeStateForTests()

  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined
  let onEvent: ((session: unknown, event: unknown) => void) | undefined
  let onClaimed: ((payload: unknown) => void) | undefined

  apply({
    on: (event, listener) => {
      if (event === 'session/event') onEvent = listener as (session: unknown, event: unknown) => void
      if (event === 'agent/inbox/claimed') onClaimed = listener as (payload: unknown) => void
    },
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })

  assert.ok(handler)
  assert.ok(onEvent)
  assert.ok(onClaimed)
  const session = persistSession('session-1')
  const agent = { session }

  const once = handler({ agent, rawInput: 'once ceo' })
  assert.equal(once.kind, 'success')
  assert.match(once.text, /this input only/)
  assert.equal(getSessionWorkMode('session-1'), 'ceo')
  assert.deepEqual(getSessionWorkModeState('session-1'), { sessionMode: 'agent', inputMode: 'ceo' })

  onEvent(session, { type: 'user/message', data: { source: { kind: 'user' } } })
  assert.equal(getSessionWorkMode('session-1'), 'ceo')

  onEvent(session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'main',
      start: 0,
      inserted: [{ id: 'msg-1', role: 'user', content: [], source: { kind: 'user' } }],
    },
  })
  assert.equal(getSessionWorkMode('session-1'), 'agent')
  assert.deepEqual(getSessionWorkModeState('session-1'), { sessionMode: 'agent', inputMode: null })
  onClaimed({ agent, message: { id: 'msg-1' } })
  assert.equal(getSessionWorkMode('session-1', session), 'ceo')
})

function persistSession(id: string) {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = []
  return {
    id,
    events,
    snapshotEvents: () => events,
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: Date.now(), data }
      Object.freeze(event)
      events.push(event)
      return event
    },
  }
}

test('persists /mode onto the session and hydrates after in-memory state is cleared', () => {
  resetWorkModeStateForTests()

  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined
  apply({
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })
  assert.ok(handler)
  const session = persistSession('session-1')
  const switched = handler({ agent: { session }, rawInput: 'ceo' })
  assert.equal(switched.kind, 'success')
  const stored = session.events.filter(event => event.type === WORK_MODE_EVENT)
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.ignorable, true)
  assert.deepEqual(stored[0]?.data, { sessionMode: 'ceo', inputMode: null, sessionId: 'session-1' })
  assert.equal(session.events.some(event => event.type === WORK_MODE_CHANGED_EVENT), false)

  resetWorkModeStateForTests()
  assert.equal(getSessionWorkMode('session-1'), 'agent')
  assert.equal(getSessionWorkMode('session-1', session), 'ceo')
  assert.deepEqual(getSessionWorkModeState('session-1', session), { sessionMode: 'ceo', inputMode: null })
})

test('hydrating a journal event without sessionId restamps it for the client chip', () => {
  resetWorkModeStateForTests()
  const session = persistSession('session-1')
  const legacy = {
    type: WORK_MODE_EVENT,
    seq: 0,
    time: Date.now(),
    data: { sessionMode: 'ceo' as const, inputMode: null },
    ignorable: true as const,
  }
  Object.freeze(legacy)
  session.events.push(legacy)
  assert.equal(getSessionWorkMode('session-1', session), 'ceo')
  const last = session.events.filter(event => event.type === WORK_MODE_EVENT).at(-1)
  assert.deepEqual(last?.data, { sessionMode: 'ceo', inputMode: null, sessionId: 'session-1' })
  assert.equal(last?.ignorable, true)
})

test('clears once-CEO when the input is queued and persists the restored session default', () => {
  resetWorkModeStateForTests()

  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined
  let onEvent: ((session: unknown, event: unknown) => void) | undefined
  apply({
    on: (event, listener) => {
      if (event === 'session/event') onEvent = listener as (session: unknown, event: unknown) => void
    },
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })
  assert.ok(handler)
  assert.ok(onEvent)
  const session = persistSession('session-1')
  handler({ agent: { session }, rawInput: 'once ceo' })
  onEvent(session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'main',
      start: 0,
      inserted: [{ id: 'msg-1', role: 'user', content: [], source: { kind: 'user' } }],
    },
  })
  assert.equal(getSessionWorkMode('session-1'), 'agent')
  const last = session.events.filter(event => event.type === WORK_MODE_EVENT).at(-1)
  assert.deepEqual(last?.data, { sessionMode: 'agent', inputMode: null, sessionId: 'session-1' })
  assert.equal(last?.ignorable, true)
  const stamp = session.events.find(event => event.type === 'magic/work-mode-input')
  assert.equal(stamp?.ignorable, true)
  assert.deepEqual(stamp?.data, {
    sessionId: 'session-1',
    messageId: 'msg-1',
    mode: 'ceo',
    sessionMode: 'agent',
    scope: 'input',
  })
})

test('a later session default does not rewrite a queued input stamp', () => {
  resetWorkModeStateForTests()
  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined
  let onEvent: ((session: unknown, event: unknown) => void) | undefined
  let onClaimed: ((payload: unknown) => void) | undefined
  apply({
    on: (event, listener) => {
      if (event === 'session/event') onEvent = listener as (session: unknown, event: unknown) => void
      if (event === 'agent/inbox/claimed') onClaimed = listener as (payload: unknown) => void
    },
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })
  assert.ok(handler)
  assert.ok(onEvent)
  assert.ok(onClaimed)
  const session = persistSession('session-1')
  handler({ agent: { session }, rawInput: 'once ceo' })
  onEvent(session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'main',
      start: 0,
      inserted: [{ id: 'msg-1', role: 'user', content: [], source: { kind: 'user' } }],
    },
  })
  handler({ agent: { session }, rawInput: 'ceo' })
  assert.equal(getSessionWorkMode('session-1'), 'ceo')
  onClaimed({ agent: { session }, message: { id: 'msg-1' } })
  assert.equal(getSessionWorkMode('session-1', session), 'ceo')
  const stamp = session.events.find(event => event.type === 'magic/work-mode-input')
  assert.deepEqual(stamp?.data, {
    sessionId: 'session-1',
    messageId: 'msg-1',
    mode: 'ceo',
    sessionMode: 'agent',
    scope: 'input',
  })
})

test('a live CEO journal blocks a session-default switch until confirm', () => {
  resetWorkModeStateForTests()
  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined
  apply({
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })
  assert.ok(handler)
  const session = persistSession('session-1')
  handler({ agent: { session }, rawInput: 'ceo' })
  session.events.push({
    type: 'ceo/run-journal',
    seq: session.events.length,
    time: 1,
    data: {
      turn: 4,
      callId: 'call-1',
      runs: [{
        runId: 'del_1_survey',
        rawId: 'survey',
        role: 'researcher',
        task: 'Survey options',
        dependsOn: [],
        phase: 'running',
        memberId: 'member-1',
      }],
    },
    ignorable: true,
  })

  const blocked = handler({ agent: { session }, rawInput: 'agent' })
  assert.equal(blocked.kind, 'error')
  assert.equal(blocked.text.startsWith(WORK_MODE_CONFIRM_PREFIX), true)
  assert.match(blocked.text, /researcher \[running\]/)
  assert.equal(getSessionWorkMode('session-1', session), 'ceo')
  assert.equal(session.events.some(event => event.type === WORK_MODE_CHANGED_EVENT), false)

  const once = handler({ agent: { session }, rawInput: 'once agent' })
  assert.equal(once.kind, 'success')
  assert.equal(getSessionWorkModeState('session-1', session).sessionMode, 'ceo')
  assert.equal(getSessionWorkModeState('session-1', session).inputMode, 'agent')

  const confirmed = handler({ agent: { session }, rawInput: 'agent confirm' })
  assert.equal(confirmed.kind, 'success')
  assert.equal(getSessionWorkMode('session-1', session), 'agent')
  const changed = session.events.find(event => event.type === WORK_MODE_CHANGED_EVENT)
  assert.equal(changed?.ignorable, true)
  assert.deepEqual(changed?.data, {
    sessionId: 'session-1',
    from: 'ceo',
    to: 'agent',
    members: [{ role: 'researcher', phase: 'running', task: 'Survey options' }],
  })
})

test('a finished CEO journal does not block a later session default', () => {
  resetWorkModeStateForTests()
  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined
  apply({
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })
  assert.ok(handler)
  const session = persistSession('session-1')
  handler({ agent: { session }, rawInput: 'ceo' })
  session.events.push({
    type: 'ceo/run-journal',
    seq: session.events.length,
    time: 1,
    data: {
      turn: 4,
      callId: 'call-1',
      runs: [{
        runId: 'del_1_survey',
        rawId: 'survey',
        role: 'researcher',
        task: 'Survey options',
        dependsOn: [],
        phase: 'completed',
        memberId: 'member-1',
      }],
    },
    ignorable: true,
  })
  const switched = handler({ agent: { session }, rawInput: 'agent' })
  assert.equal(switched.kind, 'success')
  assert.equal(getSessionWorkMode('session-1', session), 'agent')
  const changed = session.events.find(event => event.type === WORK_MODE_CHANGED_EVENT)
  assert.equal((changed?.data as { from?: string; to?: string } | undefined)?.from, 'ceo')
  assert.equal((changed?.data as { to?: string } | undefined)?.to, 'agent')
})

test('a CEO plan with no members still needs confirmation', () => {
  resetWorkModeStateForTests()
  let handler: ((invocation: { agent: { session: { id: string } }; rawInput: string }) => { kind: string; text: string }) | undefined
  apply({
    systemPrompt: { section: () => undefined },
    commands: {
      register: (definition) => {
        handler = definition.handler
      },
    },
  })
  assert.ok(handler)
  const session = persistSession('session-1')
  handler({ agent: { session }, rawInput: 'ceo' })
  session.events.push({
    type: 'ceo/plan',
    seq: session.events.length,
    time: 1,
    data: {
      turn: 4,
      planId: 'plan_1',
      version: 1,
      summary: 'Survey then build',
      analysis: 'Split the work',
      tasks: [{ role: 'researcher', task: 'Survey', dependsOn: [] }],
    },
    ignorable: true,
  })
  const blocked = handler({ agent: { session }, rawInput: 'agent' })
  assert.equal(blocked.kind, 'error')
  assert.match(blocked.text, /Goal: Survey then build/)
  assert.equal(getSessionWorkMode('session-1', session), 'ceo')
})

test('parses session default, once-CEO, and once-clear', () => {
  assert.deepEqual(parseModeCommand(''), { kind: 'show' })
  assert.deepEqual(parseModeCommand('ceo'), { kind: 'session', mode: 'ceo', confirmed: false })
  assert.deepEqual(parseModeCommand('ceo confirm'), { kind: 'session', mode: 'ceo', confirmed: true })
  assert.deepEqual(parseModeCommand('once ceo'), { kind: 'once', mode: 'ceo' })
  assert.deepEqual(parseModeCommand('once ceo confirm'), { kind: 'invalid' })
  assert.deepEqual(parseModeCommand('once'), { kind: 'once-clear' })
  assert.deepEqual(parseModeCommand('team'), { kind: 'invalid' })

  const once = applyModeCommand({ sessionMode: 'agent', inputMode: null }, { kind: 'once', mode: 'ceo' })
  assert.equal(resolveMode(once), 'ceo')
  assert.match(describeMode(once), /this input only/)

  const session = applyModeCommand(once, { kind: 'session', mode: 'ceo', confirmed: false })
  assert.deepEqual(session, { sessionMode: 'ceo', inputMode: null })
  assert.deepEqual(parseDescribedMode(describeMode(once)), once)
  assert.deepEqual(parseDescribedMode(describeMode(session)), session)
})
