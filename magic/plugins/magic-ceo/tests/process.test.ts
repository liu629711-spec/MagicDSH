import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CEO_RUN_PROCESS } from '../src/journal.ts'
import {
  attachRunProcessMirror,
  ingestChildSessionEvent,
  resetProcessMirrorsForTests,
} from '../src/process.ts'

function parentSession() {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = []
  return {
    events,
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: 1, data }
      Object.freeze(event)
      events.push(event)
      return event
    },
  }
}

test('replaces trailing thought, then records tools without a parent jump', () => {
  resetProcessMirrorsForTests()
  const parent = parentSession()
  attachRunProcessMirror({
    parent,
    turn: 4,
    callId: 'call-1',
    runId: 'del_1_survey',
    memberId: 'member-1',
    childSessionId: 'member-1',
  })
  ingestChildSessionEvent('member-1', {
    type: 'assistant/chunk',
    seq: 1,
    data: { chunk: { type: 'reasoning-delta', text: 'look' } },
  })
  ingestChildSessionEvent('member-1', {
    type: 'assistant/chunk',
    seq: 2,
    data: { chunk: { type: 'block-end', block: { type: 'reasoning', text: 'look at the market' } } },
  })
  ingestChildSessionEvent('member-1', {
    type: 'tool/call',
    seq: 3,
    data: { callId: 'tool-1', name: 'web_search', arguments: '{"query":"SLG"}' },
  })
  ingestChildSessionEvent('member-1', {
    type: 'tool/result',
    seq: 4,
    data: {
      message: {
        source: { callId: 'tool-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'tool-1',
          content: [{ type: 'text', text: 'three titles' }],
        }],
      },
      meta: {
        truncated: false,
        sources: [{
          url: 'https://example.com/hearthstone',
          title: 'Hearthstone',
          snippet: 'fast-paced strategy card game',
        }],
      },
    },
  })

  const process = parent.events.filter(event => event.type === CEO_RUN_PROCESS)
  assert.ok(process.every(event => event.ignorable === true))
  assert.deepEqual(process.map(event => (event.data as { op: { kind: string } }).op.kind), [
    'reasoning',
    'tool-start',
    'tool-end',
  ])
  assert.equal((process[0]?.data as { op: { text: string } }).op.text, 'look at the market')
  assert.equal((process[1]?.data as { op: { name: string } }).op.name, 'web_search')
  assert.equal((process[2]?.data as { op: { result?: string } }).op.result, 'three titles')
  assert.equal((process[2]?.data as { op: { sources?: Array<{ title?: string }> } }).op.sources?.[0]?.title, 'Hearthstone')
  resetProcessMirrorsForTests()
})

test('clips oversized write args but keeps file_path for the client', () => {
  resetProcessMirrorsForTests()
  const parent = parentSession()
  attachRunProcessMirror({
    parent,
    turn: 4,
    callId: 'call-1',
    runId: 'del_1_survey',
    memberId: 'member-1',
    childSessionId: 'member-1',
  })
  const content = 'x'.repeat(2000)
  ingestChildSessionEvent('member-1', {
    type: 'tool/call',
    seq: 1,
    data: {
      callId: 'tool-write',
      name: 'write',
      arguments: JSON.stringify({ content, file_path: '海外端游市场调研.md' }),
    },
  })
  const start = parent.events.find(event => event.type === CEO_RUN_PROCESS)
  const op = (start?.data as { op: { args?: string } }).op
  assert.ok(typeof op.args === 'string')
  assert.ok(op.args.length < 200)
  assert.deepEqual(JSON.parse(op.args), { file_path: '海外端游市场调研.md' })
  resetProcessMirrorsForTests()
})

test('skips process when the parent turn is missing', () => {
  resetProcessMirrorsForTests()
  const parent = parentSession()
  attachRunProcessMirror({
    parent,
    turn: undefined,
    callId: 'call-1',
    runId: 'del_1_survey',
    memberId: 'member-1',
    childSessionId: 'member-1',
  })
  ingestChildSessionEvent('member-1', {
    type: 'tool/call',
    seq: 1,
    data: { callId: 'tool-1', name: 'web_search' },
  })
  assert.equal(parent.events.length, 0)
  resetProcessMirrorsForTests()
})
