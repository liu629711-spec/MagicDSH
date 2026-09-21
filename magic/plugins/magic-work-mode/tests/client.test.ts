import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workModeChangedDefinition, workModeEventDefinition } from '../src/client/definition.ts'
import { inject, registerWorkModeUi } from '../src/client/register.ts'
import {
  applyClientWorkModeLine,
  getClientWorkMode,
  resetClientWorkModeForTests,
} from '../src/client/state.ts'
import { describeMode } from '../src/mode.ts'
import { WORK_MODE_CONFIRM_PREFIX } from '../src/handoff.ts'
import { WORK_MODE_CHANGED_EVENT, WORK_MODE_EVENT } from '../src/persist.ts'

test('registers the composer-left work-mode control', async () => {
  resetClientWorkModeForTests()
  const sections: string[] = []
  const slots: Array<{ name: string; id?: string }> = []
  let execute: ((line: string) => Promise<string | null>) | undefined
  let executed: ((sessionId: unknown, name: unknown, result: unknown) => void) | undefined

  const definitions: Array<{ kind?: string }> = []
  registerWorkModeUi({
    uiConversation: {
      events: {
        register: (value) => {
          definitions.push(value as { kind?: string })
        },
      },
    },
    locale: {
      register: (ns, dicts) => {
        sections.push(ns)
        assert.equal(dicts.zh['chip.agent'], '代理')
        assert.equal(dicts.zh['chip.ceo'], 'CEO')
        assert.equal(dicts.zh['scope.input'], '本次输入')
        assert.equal(dicts.zh['menu.onceCeo'], 'CEO · 本次输入')
        assert.equal(dicts.zh['menu.sessionCeo'], 'CEO · 当前会话')
        assert.equal(dicts.zh['confirm.continue'], '继续改')
        assert.equal(dicts.zh['changed.title'], '工作方式已改变')
        assert.equal(dicts.en['menu.agentHint'].includes('Later inputs'), true)
        return () => {}
      },
    },
    remote: {
      commands: {
        execute: async (_sessionId, line) => ({
          ok: true,
          value: {
            result: {
              kind: 'success',
              text: describeMode({
                sessionMode: 'agent',
                inputMode: line.includes('once') ? 'ceo' : null,
              }),
            },
          },
        }),
      },
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (spec) => {
        slots.push({
          name: String(spec.name),
          id: spec.id === undefined ? undefined : String(spec.id),
        })
        const injected = typeof spec.inject === 'function'
          ? spec.inject('session-1') as { executeMode?: (line: string) => Promise<string | null> }
          : undefined
        if (injected?.executeMode !== undefined) execute = injected.executeMode
      },
    },
    effect: (factory) => factory(),
    on: (event, listener) => {
      if (event === 'command/executed') executed = listener as (sessionId: unknown, name: unknown, result: unknown) => void
    },
  }, { chip: 'chip', changed: 'changed' })

  assert.deepEqual(inject, ['slots', 'remote', 'remote.commands', 'locale', 'uiConversation'])
  assert.equal(definitions[0]?.kind, 'magic-work-mode')
  assert.equal(definitions[1]?.kind, 'magic-work-mode-changed')
  assert.equal(sections[0], 'magicWorkMode')
  assert.deepEqual(slots, [
    { name: 'conversation.input.left', id: 'magic-work-mode' },
    { name: 'conversation.chat.node', id: undefined },
  ])
  assert.equal(typeof execute, 'function')
  assert.ok(executed)

  assert.equal(await execute?.('/mode once ceo'), null)
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'agent', inputMode: 'ceo' })

  executed?.('session-1', 'mode', {
    kind: 'success',
    text: describeMode({ sessionMode: 'ceo', inputMode: null }),
  })
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'ceo', inputMode: null })
})

test('client mirror records once-CEO separately from the session default', () => {
  resetClientWorkModeForTests()
  applyClientWorkModeLine('session-1', '/mode once ceo')
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'agent', inputMode: 'ceo' })
  applyClientWorkModeLine('session-1', '/mode ceo')
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'ceo', inputMode: null })
  applyClientWorkModeLine('session-1', '/mode agent')
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'agent', inputMode: null })
})

test('folds a persisted work-mode event onto the composer chip', () => {
  resetClientWorkModeForTests()
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'agent', inputMode: null })
  assert.equal(workModeEventDefinition.match({ type: 'turn/start', seq: 1 }), null)
  assert.deepEqual(workModeEventDefinition.match({
    type: WORK_MODE_EVENT,
    seq: 4,
    data: { sessionMode: 'ceo', inputMode: null, sessionId: 'session-1' },
  }), { id: '4', role: 'start' })
  workModeEventDefinition.start(undefined, {
    event: {
      data: { sessionMode: 'ceo', inputMode: null, sessionId: 'session-1' },
    },
  })
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'ceo', inputMode: null })
})

test('executeMode forwards a confirm error instead of applying the chip', async () => {
  resetClientWorkModeForTests()
  let execute: ((line: string) => Promise<string | null>) | undefined
  registerWorkModeUi({
    uiConversation: { events: { register: () => undefined } },
    locale: { register: () => () => {} },
    remote: {
      commands: {
        execute: async (_sessionId, line) => ({
          ok: true,
          value: {
            result: line.includes('confirm')
              ? {
                kind: 'success',
                text: describeMode({ sessionMode: 'agent', inputMode: null }),
              }
              : {
                kind: 'error',
                text: `${WORK_MODE_CONFIRM_PREFIX}\nGoal: Survey then build`,
              },
          },
        }),
      },
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (spec) => {
        const injected = typeof spec.inject === 'function'
          ? spec.inject('session-1') as { executeMode?: (line: string) => Promise<string | null> }
          : undefined
        if (injected?.executeMode !== undefined) execute = injected.executeMode
      },
    },
    effect: (factory) => factory(),
  }, { chip: 'chip', changed: 'changed' })

  const blocked = await execute?.('/mode agent')
  assert.equal(blocked?.startsWith(WORK_MODE_CONFIRM_PREFIX), true)
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'agent', inputMode: null })

  assert.equal(await execute?.('/mode agent confirm'), null)
  assert.deepEqual(getClientWorkMode('session-1'), { sessionMode: 'agent', inputMode: null })
})

test('folds a work-mode-changed notice onto a chat card', () => {
  const data = {
    sessionId: 'session-1',
    from: 'ceo' as const,
    to: 'agent' as const,
    summary: 'Survey then build',
    members: [{ role: 'researcher', phase: 'running', task: 'Survey options' }],
  }
  assert.equal(workModeChangedDefinition.match({ type: WORK_MODE_EVENT, seq: 1 }), null)
  assert.deepEqual(workModeChangedDefinition.match({
    type: WORK_MODE_CHANGED_EVENT,
    seq: 8,
    data,
  }), { id: '8', role: 'start' })
  assert.deepEqual(workModeChangedDefinition.start(undefined, { event: { data } }), data)
  assert.equal(workModeChangedDefinition.target, 'chat')
  assert.equal(workModeChangedDefinition.buildViewNode({
    key: 'magic-work-mode-changed:8',
    id: '8',
    state: undefined,
    start: { event: { seq: 8 }, location: { kind: 'unresolved' } },
  }), null)
  assert.deepEqual(workModeChangedDefinition.buildViewNode({
    key: 'magic-work-mode-changed:8',
    id: '8',
    state: data,
    start: { event: { seq: 8 }, location: { kind: 'unresolved' } },
  }), {
    key: 'magic-work-mode-changed:8',
    kind: 'magic-work-mode-changed',
    id: '8',
    target: 'chat',
    anchorSeq: 8,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data,
  })
})
