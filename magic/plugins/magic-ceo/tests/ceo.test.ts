import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, listCeoMembers, resetCeoStateForTests, CEO_MEMBER_RESULT, CEO_PLAN, CEO_RUN_JOURNAL, CEO_RUN_PROCESS } from '../src/index.ts'

function journalSession(id: string) {
  const events: Array<{ type: string; seq: number; time: number; data: unknown; ignorable?: true }> = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 4 } },
  ]
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

function harness(mode: 'agent' | 'ceo' = 'ceo', extra: Record<string, unknown> = {}) {
  resetCeoStateForTests()

  const sections: Array<{
    name: string
    order: number
    text?: string | ((context?: { agent?: { session?: { id?: string } } }) => string)
  }> = []
  const tools = new Map<string, Parameters<Parameters<typeof apply>[0]['tools']['register']>[0]>()
  const started: Array<{ provider: string; label: string; prompt: string; parentId: string }> = []
  const sent: Array<{ targetId: string; text: string }> = []
  const seqByChild = new Map<string, number>()
  const release = new Map<string, (output?: string, stopReason?: string) => void>()
  const listeners: Array<(session: { id: string }, event: unknown) => void> = []

  apply({
    magicWorkMode: {
      getMode: () => mode,
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
      },
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
      },
    },
    subagents: {
      startContinuable: async (spec) => {
        const id = `member-${String(started.length + 1)}`
        started.push({
          provider: spec.provider,
          label: spec.label,
          prompt: spec.request.prompt[0]?.text ?? '',
          parentId: spec.request.parent.session.id,
        })
        release.set(id, (output = `status: completed\ndone: done by ${id}`, stopReason = 'completed') => {
          const messageSeq = (seqByChild.get(id) ?? 0) + 1
          seqByChild.set(id, messageSeq)
          for (const listener of listeners) {
            listener({ id }, {
              type: 'assistant/message',
              seq: messageSeq,
              data: { message: { content: [{ type: 'text', text: output }] } },
            })
          }
          const endSeq = (seqByChild.get(id) ?? messageSeq) + 1
          seqByChild.set(id, endSeq)
          for (const listener of listeners) {
            listener({ id }, {
              type: 'turn/end',
              seq: endSeq,
              data: { turn: 1, reason: { kind: stopReason } },
            })
          }
        })
        return { childId: id }
      },
      sendMessage: async (_sender, targetId, content) => {
        sent.push({ targetId, text: content[0]?.text ?? '' })
        return `msg-${String(sent.length)}`
      },
    },
    on: (_event, listener) => {
      listeners.push(listener as (session: { id: string }, event: unknown) => void)
    },
    ...extra,
  })

  const emitChild = (id: string, event: { type: string; seq: number; data: unknown }) => {
    if (event.seq > (seqByChild.get(id) ?? 0)) seqByChild.set(id, event.seq)
    for (const listener of listeners) listener({ id }, event)
  }

  return {
    sections,
    tool: () => tools.get('ceo_delegate'),
    plan: () => tools.get('ceo_plan'),
    replan: () => tools.get('ceo_replan'),
    started,
    sent,
    release,
    emitChild,
  }
}

async function recordPlan(
  plan: ReturnType<typeof harness>['plan'],
  tasks: unknown[],
  session = journalSession('session-1'),
) {
  const tool = plan()
  assert.ok(tool)
  await tool.execute({
    summary: 'Deliver a researched answer.',
    analysis: 'Split independent evidence gathering, then synthesize only after sources and acceptance are clear.',
    tasks,
  }, { agent: { session }, signal: new AbortController().signal })
  return session
}

test('registers a CEO prompt section and ceo_delegate tool', () => {
  const { sections, tool, plan } = harness()
  assert.equal(sections[0]?.name, 'magic-ceo')
  assert.equal(tool()?.name, 'ceo_delegate')
  assert.equal(plan()?.name, 'ceo_plan')
  const text = typeof sections[0]?.text === 'function' ? sections[0].text() : ''
  assert.match(text, /tasks\[\]/)
  assert.match(text, /ceo_replan/)
  assert.match(text, /Do not paste JSON schemas/)
  assert.match(text, /Do not call ceo_delegate/)
})

test('CEO session prompt hard-routes breadth research to ceo_delegate', () => {
  const { sections } = harness('ceo')
  const textFn = sections[0]?.text
  assert.equal(typeof textFn, 'function')
  const text = (textFn as (context?: unknown) => string)({ agent: { session: { id: 'session-1' } } })
  assert.match(text, /in CEO mode now/)
  assert.match(text, /first stream a useful analysis/)
  assert.match(text, /ceo_plan/)
  assert.match(text, /Do not perform breadth web research yourself/)
  assert.match(text, /海内外/)
  assert.match(text, /Do not call ceo_delegate again/)
  assert.match(text, /国内市场/)
  assert.doesNotMatch(text, /English labels like research/)
  assert.doesNotMatch(text, /in agent mode/)
})

test('agent session prompt still forbids ceo_delegate', () => {
  const { sections } = harness('agent')
  const textFn = sections[0]?.text
  assert.equal(typeof textFn, 'function')
  const text = (textFn as (context?: unknown) => string)({ agent: { session: { id: 'session-1' } } })
  assert.match(text, /in agent mode/)
  assert.match(text, /Do not call ceo_delegate/)
  assert.doesNotMatch(text, /in CEO mode now/)
})

test('rejects delegation unless the session is in CEO mode', async () => {
  const { tool } = harness('agent')
  const delegate = tool()
  assert.ok(delegate)

  await assert.rejects(
    () => delegate.execute(
      { tasks: [{ role: 'reviewer', task: 'Review the API.' }] },
      { agent: { session: { id: 'session-1' } }, signal: new AbortController().signal },
    ),
    /CEO work mode/,
  )
})

test('requires a matching plan before complex delegation', async () => {
  const { tool, plan } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)

  const tasks = [
    { role: 'market researcher', task: 'Survey the market', id: 'market' },
    { role: 'source reviewer', task: 'Validate the sources', id: 'sources' },
  ]
  await assert.rejects(
    () => delegate.execute(
      { tasks },
      { agent: { session: { id: 'session-1' } }, signal: new AbortController().signal },
    ),
    /requires ceo_plan first/,
  )

  await recordPlan(plan, tasks)
  await assert.rejects(
    () => delegate.execute(
      { tasks: [{ role: 'market researcher', task: 'Survey another market', id: 'market' }] },
      { agent: { session: { id: 'session-1' } }, signal: new AbortController().signal },
    ),
    /do not match the latest CEO plan/,
  )
})

test('starts independent tasks together and records the run graph', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')

  await recordPlan(plan, [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'reviewer', task: 'List risks', id: 'risks' },
  ], session)

  const pending = delegate.execute(
    {
      tasks: [
        { role: 'researcher', task: 'Survey options', id: 'survey' },
        { role: 'reviewer', task: 'List risks', id: 'risks' },
      ],
    },
    { agent: { session }, signal: new AbortController().signal },
  )

  await Promise.resolve()
  assert.equal(started.length, 2)
  assert.equal(started[0]?.provider, 'spawn')
  assert.match(started[0]?.prompt ?? '', /status: completed \| blocked \| failed \| partial/)
  assert.match(started[0]?.prompt ?? '', /Survey options/)
  assert.doesNotMatch(started[0]?.prompt ?? '', /Shared team brief/)
  release.get('member-1')?.()
  release.get('member-2')?.()
  const result = await pending
  assert.equal(result.runs!.length, 2)
  assert.equal(result.runs![0]?.phase, 'completed')
  assert.equal(listCeoMembers('session-1')[0]?.role, 'researcher')
  assert.equal(listCeoMembers('session-1')[0]?.task, 'Survey options')
})

test('puts the CEO plan team brief on every worker prompt', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  const planTool = plan()
  assert.ok(delegate)
  assert.ok(planTool)
  const session = journalSession('session-1')
  const tasks = [{ role: 'researcher', task: 'Survey options', id: 'survey' }]
  await planTool.execute({
    summary: 'Deliver a researched answer.',
    analysis: 'Split independent evidence gathering, then synthesize only after sources and acceptance are clear.',
    team_brief: 'Prefer primary sources over recaps.',
    tasks,
  }, { agent: { session }, signal: new AbortController().signal })
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  assert.match(started[0]?.prompt ?? '', /Shared team brief/)
  assert.match(started[0]?.prompt ?? '', /Prefer primary sources over recaps/)
  release.get('member-1')?.()
  await pending
})

test('does not start a dependent task until the producer finishes', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')

  await recordPlan(plan, [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'implementer', task: 'Build it', depends_on: ['survey'] },
  ], session)

  const pending = delegate.execute(
    {
      tasks: [
        { role: 'researcher', task: 'Survey options', id: 'survey' },
        { role: 'implementer', task: 'Build it', depends_on: ['survey'] },
      ],
    },
    { agent: { session }, signal: new AbortController().signal },
  )

  await Promise.resolve()
  assert.equal(started.length, 1)
  assert.equal(started[0]?.label, 'researcher')
  release.get('member-1')?.()
  for (let i = 0; i < 20 && started.length < 2; i++) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.equal(started.length, 2)
  assert.match(started[1]?.prompt ?? '', /Upstream results/)
  release.get('member-2')?.()
  const result = await pending
  assert.equal(result.runs![1]?.phase, 'completed')
  assert.equal(listCeoMembers('session-1')[1]?.dependsOn[0], result.runs![0]?.runId)
})

test('appends an ignorable run journal while the graph is in flight', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  await recordPlan(plan, [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'implementer', task: 'Build it', id: 'build', depends_on: ['survey'] },
  ], session)

  const pending = delegate.execute(
    {
      tasks: [
        { role: 'researcher', task: 'Survey options', id: 'survey' },
        { role: 'implementer', task: 'Build it', id: 'build', depends_on: ['survey'] },
      ],
    },
    {
      agent: { session },
      callId: 'call-1',
      signal: new AbortController().signal,
    },
  )

  await Promise.resolve()
  const journals = () => session.events.filter(event => event.type === CEO_RUN_JOURNAL)
  assert.ok(journals().length >= 2)
  assert.equal(journals()[0]?.ignorable, true)
  assert.equal((journals()[0]?.data as { turn?: number }).turn, 4)
  const firstRuns = (journals()[0]?.data as { runs: Array<{ rawId: string; phase: string }> }).runs
  assert.deepEqual(firstRuns.map(run => `${run.rawId}:${run.phase}`), ['survey:queued', 'build:queued'])
  const live = journals().at(-1)?.data as { runs: Array<{ rawId: string; phase: string }> }
  assert.equal(live.runs.find(run => run.rawId === 'survey')?.phase, 'running')
  assert.equal(live.runs.find(run => run.rawId === 'build')?.phase, 'queued')

  release.get('member-1')?.()
  for (let i = 0; i < 20 && started.length < 2; i++) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  const mid = journals().at(-1)?.data as { runs: Array<{ rawId: string; phase: string; memberId?: string }> }
  assert.equal(mid.runs.find(run => run.rawId === 'survey')?.phase, 'completed')
  assert.equal(mid.runs.find(run => run.rawId === 'build')?.phase, 'running')
  release.get('member-2')?.()
  await pending
  const last = journals().at(-1)?.data as { runs: Array<{ rawId: string; phase: string }> }
  assert.deepEqual(last.runs.map(run => `${run.rawId}:${run.phase}`), ['survey:completed', 'build:completed'])
  assert.ok(journals().every(event => event.ignorable === true))
})

test('restores the latest ceo_plan from session events after in-memory state is cleared', async () => {
  const { tool, plan, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [
    { role: 'market researcher', task: 'Survey the market', id: 'market' },
    { role: 'source reviewer', task: 'Validate the sources', id: 'sources' },
  ]
  await recordPlan(plan, tasks, session)
  assert.equal(session.events.some(event => event.type === CEO_PLAN), true)

  resetCeoStateForTests()
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.()
  release.get('member-2')?.()
  const result = await pending
  assert.equal(result.runs!.length, 2)
  assert.equal(result.runs![0]?.phase, 'completed')
})

test('treats declared completed plus a non-completed stop as unverified', async () => {
  const { tool, plan, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [{ role: 'researcher', task: 'Survey options', id: 'survey' }]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.('status: completed\ndone: surveyed two options', 'aborted')
  const result = await pending
  assert.equal(result.runs![0]?.phase, 'unverified')
  const event = session.events.find(item => item.type === CEO_MEMBER_RESULT)
  assert.equal((event?.data as { status?: string } | undefined)?.status, 'unverified')
})

test('restamps in-flight journal nodes as unknown_after_restart after process restart', () => {
  const { sections } = harness('ceo')
  const session = journalSession('session-1')
  session.events.push({
    type: CEO_RUN_JOURNAL,
    seq: 1,
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
  const textFn = sections[0]?.text
  assert.equal(typeof textFn, 'function')
  const callText = textFn as (context?: unknown) => string
  callText({ agent: { session } })
  const journals = session.events.filter(event => event.type === CEO_RUN_JOURNAL)
  const last = journals.at(-1)?.data as { runs: Array<{ phase: string }> }
  assert.equal(last.runs[0]?.phase, 'unknown_after_restart')
  assert.equal(journals.at(-1)?.ignorable, true)
})

test('does not rewrite a live in-flight journal as unknown', async () => {
  const { tool, plan, release, sections } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  await recordPlan(plan, [{ role: 'researcher', task: 'Survey options', id: 'survey' }], session)
  const pending = delegate.execute(
    { tasks: [{ role: 'researcher', task: 'Survey options', id: 'survey' }] },
    { agent: { session }, callId: 'call-1', signal: new AbortController().signal },
  )
  await Promise.resolve()
  const textFn = sections[0]?.text
  assert.equal(typeof textFn, 'function')
  const callText = textFn as (context?: unknown) => string
  callText({ agent: { session } })
  const live = session.events.filter(event => event.type === CEO_RUN_JOURNAL).at(-1)?.data as {
    runs: Array<{ phase: string }>
  }
  assert.equal(live.runs[0]?.phase, 'running')
  release.get('member-1')?.()
  await pending
})

test('treats unstructured completed output as unverified and skips dependents', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'implementer', task: 'Build it', id: 'build', depends_on: ['survey'] },
  ]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.('I looked at a few sites and wrote some notes.')
  const result = await pending
  assert.equal(started.length, 1)
  assert.equal(result.runs![0]?.phase, 'unverified')
  assert.equal(result.runs![1]?.phase, 'skipped')
  const event = session.events.find(item => item.type === CEO_MEMBER_RESULT)
  assert.equal((event?.data as { status?: string } | undefined)?.status, 'unverified')
})

test('records the final worker output without relying on send_message and blocks unverified research', async () => {
  const { tool, plan, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [{ role: 'market researcher', task: 'Survey the market', id: 'market' }]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session }, callId: 'call-1', signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.(
    '{"status":"partial","done":"Drafted a report","risks_or_blockers":"无法联网核验核心数字，仅估计"}',
  )
  const result = await pending
  assert.equal(result.runs![0]?.phase, 'failed')
  const event = session.events.find(item => item.type === CEO_MEMBER_RESULT)
  assert.equal(event?.ignorable, true)
  assert.match(String((event?.data as { output?: string } | undefined)?.output), /无法联网核验/)
})

test('research evidence gap with an explicit no-decision degrades to partial and does not yield (2026-09-14 user ruling)', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [{ role: 'market researcher', task: 'Survey the market', id: 'market' }]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session }, callId: 'call-1', signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.(
    'status: completed\ndone: surveyed with secondary sources\nnot_done: Sensor Tower 原始报告页因网络不可达未能直接访问\nuser_decisions: 无（未遇到需要用户决策的分叉点）',
  )
  const result = await pending
  assert.equal(started.length, 1)
  assert.equal(result.yielded, undefined)
  assert.equal(result.runs![0]?.phase, 'completed')
  const event = session.events.find(item => item.type === CEO_MEMBER_RESULT)
  assert.equal((event?.data as { status?: string } | undefined)?.status, 'partial')
})

test('research evidence gap still blocks when the member declares blocked', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [
    { role: 'market researcher', task: 'Survey the market', id: 'market' },
    { role: 'implementer', task: 'Build it', id: 'build', depends_on: ['market'] },
  ]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session }, callId: 'call-1', signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.(
    'status: blocked\ndone: stopped at the paywall\nuser_decisions: 无',
  )
  const result = await pending
  assert.equal(started.length, 1)
  // declared blocked 映射为 failed（非 blocked phase），依赖节点被 skip 而非挂起：
  // 挂起等拍板只发生在 phase==='blocked'（真 user_decisions 问题）时。
  assert.equal(result.runs![0]?.phase, 'failed')
  assert.equal(result.runs![1]?.phase, 'skipped')
})

test('stamps memberId while the child is still running and mirrors its process', async () => {
  const { tool, plan, started, release, emitChild } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  await recordPlan(plan, [{ role: 'researcher', task: 'Survey options', id: 'survey' }], session)
  const pending = delegate.execute(
    { tasks: [{ role: 'researcher', task: 'Survey options', id: 'survey' }] },
    {
      agent: { session },
      callId: 'call-1',
      signal: new AbortController().signal,
    },
  )
  await Promise.resolve()
  const journals = () => session.events.filter(event => event.type === CEO_RUN_JOURNAL)
  const live = journals().at(-1)?.data as { runs: Array<{ rawId: string; phase: string; memberId?: string }> }
  assert.equal(live.runs[0]?.phase, 'running')
  assert.equal(live.runs[0]?.memberId, 'member-1')
  assert.equal(started.length, 1)

  emitChild('member-1', {
    type: 'tool/call',
    seq: 0,
    data: { callId: 'tool-1', name: 'web_search', arguments: '{}' },
  })
  const process = session.events.filter(event => event.type === CEO_RUN_PROCESS)
  assert.equal(process.length, 1)
  assert.equal(process[0]?.ignorable, true)
  assert.equal((process[0]?.data as { op: { kind: string; name?: string } }).op.kind, 'tool-start')
  assert.equal((process[0]?.data as { op: { name?: string } }).op.name, 'web_search')

  release.get('member-1')?.()
  await pending
})

test('yields when a member asks for a user decision and continues the same child', async () => {
  const { tool, plan, replan, started, sent, release } = harness('ceo')
  const delegate = tool()
  const resume = replan()
  assert.ok(delegate)
  assert.ok(resume)
  const session = journalSession('session-1')
  const tasks = [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'implementer', task: 'Build it', id: 'build', depends_on: ['survey'] },
  ]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.(
    'status: blocked\ndone: shortlisted two options\nuser_decisions: which option should we take?',
  )
  const yielded = await pending
  assert.equal(started.length, 1)
  assert.equal(yielded.yielded, 'decision')
  assert.equal(yielded.runs![0]?.phase, 'blocked')
  assert.equal(yielded.runs![1]?.phase, 'queued')
  assert.equal(listCeoMembers('session-1')[0]?.memberId, 'member-1')

  const continued = resume.execute({
    continue: [{ run_id: 'survey', answer: 'take option A' }],
  }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  assert.equal(started.length, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.targetId, 'member-1')
  assert.match(sent[0]?.text ?? '', /take option A/)
  release.get('member-1')?.('status: completed\ndone: surveyed option A')
  for (let i = 0; i < 20 && started.length < 2; i++) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  release.get('member-2')?.()
  const result = await continued
  assert.equal(result.runs![0]?.phase, 'completed')
  assert.equal(result.runs![1]?.phase, 'completed')
  assert.equal(result.runs![0]?.memberId, 'member-1')
})

test('does not yield on an empty 用户决策', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [{ role: 'researcher', task: 'Survey options', id: 'survey' }]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.(
    'status: completed\ndone: surveyed the market\n用户决策：无。',
  )
  const result = await pending
  assert.equal(started.length, 1)
  assert.equal(result.yielded, undefined)
  assert.equal(result.runs![0]?.phase, 'completed')
})

test('does not yield on 无 followed by a parenthetical explanation (2026-09-14 live regression)', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [{ role: 'researcher', task: 'Survey options', id: 'survey' }]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.(
    'status: completed\ndone: surveyed the market with 360 cross-checks\n用户决策：无（未遇到需要用户决策的分叉点）',
  )
  const result = await pending
  assert.equal(started.length, 1)
  assert.equal(result.yielded, undefined)
  assert.equal(result.runs![0]?.phase, 'completed')
})

test('still yields on a real decision question after a negation word', async () => {
  const { tool, plan, started, release } = harness('ceo')
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')
  const tasks = [{ role: 'researcher', task: 'Survey options', id: 'survey' }]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.(
    'status: blocked\ndone: shortlisted two vendors\n用户决策：是否优先覆盖下载量还是收入',
  )
  const result = await pending
  assert.equal(started.length, 1)
  assert.equal(result.yielded, 'decision')
  assert.equal(result.runs![0]?.phase, 'blocked')
})

test('yields a bind_after_deps node until ceo_replan binds it', async () => {
  const { tool, plan, replan, started, release } = harness('ceo')
  const delegate = tool()
  const resume = replan()
  assert.ok(delegate)
  assert.ok(resume)
  const session = journalSession('session-1')
  const tasks = [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'synthesizer', task: 'placeholder', id: 'synth', depends_on: ['survey'], bind_after_deps: true },
  ]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.()
  const yielded = await pending
  assert.equal(started.length, 1)
  assert.equal(yielded.yielded, 'bind')
  assert.equal(yielded.runs![1]?.phase, 'queued')

  const bound = resume.execute({
    binds: [{ run_id: 'synth', task: 'Synthesize the surveyed options' }],
  }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  for (let i = 0; i < 20 && started.length < 2; i++) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.equal(started.length, 2)
  assert.match(started[1]?.prompt ?? '', /Synthesize the surveyed options/)
  release.get('member-2')?.()
  const result = await bound
  assert.equal(result.runs![1]?.phase, 'completed')
})

test('ceo_replan add can depend on an existing graph node', async () => {
  const { tool, plan, replan, started, release } = harness('ceo')
  const delegate = tool()
  const resume = replan()
  assert.ok(delegate)
  assert.ok(resume)
  const session = journalSession('session-1')
  const tasks = [{ role: 'researcher', task: 'Survey options', id: 'survey' }]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.()
  const first = await pending
  assert.equal(first.runs!.length, 1)
  assert.equal(first.runs![0]?.phase, 'completed')

  const added = resume.execute({
    add: [{ role: 'implementer', task: 'Build it', id: 'build', depends_on: ['survey'] }],
  }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  for (let i = 0; i < 20 && started.length < 2; i++) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.equal(started.length, 2)
  assert.equal(started[1]?.label, 'implementer')
  assert.match(started[1]?.prompt ?? '', /Upstream results/)
  release.get('member-2')?.()
  const result = await added
  assert.equal(result.runs!.length, 2)
  assert.equal(result.runs![1]?.phase, 'completed')
  assert.equal(listCeoMembers('session-1')[1]?.dependsOn[0], first.runs![0]?.runId)
})

test('restored graph carries member output into the next worker', async () => {
  const { tool, plan, replan, started, release } = harness('ceo')
  const delegate = tool()
  const resume = replan()
  assert.ok(delegate)
  assert.ok(resume)
  const session = journalSession('session-1')
  const tasks = [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'synthesizer', task: 'placeholder', id: 'synth', depends_on: ['survey'], bind_after_deps: true },
  ]
  await recordPlan(plan, tasks, session)
  const pending = delegate.execute({ tasks }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  await Promise.resolve()
  release.get('member-1')?.('status: completed\ndone: surveyed option A from filings')
  await pending
  resetCeoStateForTests()

  const bound = resume.execute({
    binds: [{ run_id: 'synth', task: 'Synthesize the surveyed options' }],
  }, {
    agent: { session },
    callId: 'call-1',
    signal: new AbortController().signal,
  })
  for (let i = 0; i < 20 && started.length < 2; i++) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.equal(started.length, 2)
  assert.match(started[1]?.prompt ?? '', /Upstream results/)
  assert.match(started[1]?.prompt ?? '', /surveyed option A from filings/)
  release.get('member-2')?.()
  await bound
})

test('keeps queued journal nodes after restart so they can be redispatched', () => {
  const { sections } = harness('ceo')
  const session = journalSession('session-1')
  session.events.push({
    type: CEO_RUN_JOURNAL,
    seq: 1,
    time: 1,
    data: {
      turn: 4,
      callId: 'call-1',
      runs: [
        {
          runId: 'del_1_survey',
          rawId: 'survey',
          role: 'researcher',
          task: 'Survey options',
          dependsOn: [],
          phase: 'running',
          memberId: 'member-1',
        },
        {
          runId: 'del_1_build',
          rawId: 'build',
          role: 'implementer',
          task: 'Build it',
          dependsOn: ['del_1_survey'],
          phase: 'queued',
        },
      ],
    },
    ignorable: true,
  })
  const textFn = sections[0]?.text
  assert.equal(typeof textFn, 'function')
  const callText = textFn as (context?: unknown) => string
  callText({ agent: { session } })
  const last = session.events.filter(event => event.type === CEO_RUN_JOURNAL).at(-1)?.data as {
    runs: Array<{ rawId: string; phase: string }>
  }
  assert.equal(last.runs[0]?.phase, 'unknown_after_restart')
  assert.equal(last.runs[1]?.phase, 'queued')
})

test('official roster spawn is preferred and its member id becomes the child id', async () => {
  const spawnedOfficial: Array<{ name: string; description: string; prompt: string }> = []
  const officialMessages: Array<{ target: string; text: string }> = []
  const officialInterrupts: string[] = []
  let officialSeq = 0
  const fakeTeams = {
    spawnTeammate: async (_caller: unknown, request: { name: string; description: string; prompt: Array<{ type: string; text: string }> }) => {
      officialSeq += 1
      spawnedOfficial.push({ name: request.name, description: request.description, prompt: request.prompt[0]?.text ?? '' })
      return { member: { id: `official-${String(officialSeq)}`, name: request.name, status: 'running' } }
    },
    sendMessage: async (_caller: unknown, request: { target: string; content: Array<{ type: string; text: string }> }) => {
      officialMessages.push({ target: request.target, text: request.content[0]?.text ?? '' })
      return { messageId: 'tm-1', status: 'accepted' }
    },
    interrupt: (_caller: unknown, targetName: string) => {
      officialInterrupts.push(targetName)
    },
  }
  const { tool, plan, started, emitChild } = harness('ceo', { get: (name: string) => (name === 'agentTeams' ? fakeTeams : undefined) })
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')

  await recordPlan(plan, [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
    { role: 'reviewer', task: 'List risks', id: 'risks' },
  ], session)

  const pending = delegate.execute(
    {
      tasks: [
        { role: 'researcher', task: 'Survey options', id: 'survey' },
        { role: 'reviewer', task: 'List risks', id: 'risks' },
      ],
    },
    { agent: { session }, signal: new AbortController().signal },
  )
  await Promise.resolve()
  await Promise.resolve()
  // 两个成员都走了官方名册，没有走 startContinuable
  assert.equal(started.length, 0)
  assert.equal(spawnedOfficial.length, 2)
  assert.match(spawnedOfficial[0]?.name ?? '', /^m-del-[0-9]+-survey$/)
  assert.match(spawnedOfficial[1]?.name ?? '', /^m-del-[0-9]+-risks$/)
  assert.ok((spawnedOfficial[0]?.description.length ?? 0) <= 200)
  // 官方成员 id 就是 childId：回合事件按它送达（先结构化自报，再收尾）
  for (const id of ['official-1', 'official-2']) {
    emitChild(id, { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'status: completed\ndone: done' }] } } })
    emitChild(id, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  }
  const result = await pending
  assert.equal(result.runs!.length, 2)
  // 同一波次完成顺序不定，断言集合而非顺序
  assert.deepEqual(result.runs!.map(run => run.memberId).sort(), ['official-1', 'official-2'])
  for (const run of result.runs!) assert.equal(run.phase, 'completed')
})

test('official spawn failure falls back to subagents and the graph still completes', async () => {
  const fakeTeams = {
    spawnTeammate: async () => {
      throw new Error('Team member limit 8 reached')
    },
    sendMessage: async () => {
      throw new Error('mailbox unavailable')
    },
  }
  const { tool, plan, started, release } = harness('ceo', { get: (name: string) => (name === 'agentTeams' ? fakeTeams : undefined) })
  const delegate = tool()
  assert.ok(delegate)
  const session = journalSession('session-1')

  await recordPlan(plan, [
    { role: 'researcher', task: 'Survey options', id: 'survey' },
  ], session)

  const pending = delegate.execute(
    { tasks: [{ role: 'researcher', task: 'Survey options', id: 'survey' }] },
    { agent: { session }, signal: new AbortController().signal },
  )
  await Promise.resolve()
  await Promise.resolve()
  // 官方派工失败 ⇒ 回退 startContinuable
  assert.equal(started.length, 1)
  release.get('member-1')?.()
  const result = await pending
  assert.equal(result.runs!.length, 1)
  assert.equal(result.runs![0]?.phase, 'completed')
})
