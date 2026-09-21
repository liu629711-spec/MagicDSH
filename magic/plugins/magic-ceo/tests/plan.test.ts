import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendTasksToPlan, buildRunPlan, parseDelegateTasks } from '../src/builder.ts'
import { RunPlanError } from '../src/plan.ts'
import { WaveScheduler } from '../src/wave.ts'

test('independent tasks sit in one wave', () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { role: 'researcher', task: 'Survey options', id: 'survey' },
      { role: 'reviewer', task: 'List risks', id: 'risks' },
    ],
  }), 'del_1')
  const waves = plan.waves()
  assert.equal(waves.length, 1)
  assert.deepEqual(waves[0]?.map(node => node.rawId), ['survey', 'risks'])
})

test('depends_on occupies successive waves and resolves role names', () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { role: 'researcher', task: 'Survey options' },
      { role: 'implementer', task: 'Build it', depends_on: ['researcher'] },
    ],
  }), 'del_1')
  const waves = plan.waves()
  assert.equal(waves.length, 2)
  assert.equal(waves[0]?.[0]?.role, 'researcher')
  assert.equal(waves[1]?.[0]?.role, 'implementer')
  assert.equal(waves[1]?.[0]?.dependsOn[0], waves[0]?.[0]?.runId)
})

test('rejects a cycle', () => {
  assert.throws(() => buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'a', role: 'one', task: 'A', depends_on: ['b'] },
      { id: 'b', role: 'two', task: 'B', depends_on: ['a'] },
    ],
  }), 'del_1'), RunPlanError)
})

test('scheduler starts a dependent node only after its producer finishes', async () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] },
    ],
  }), 'del_1')
  const order: string[] = []
  const release = Promise.withResolvers<void>()
  const running = new WaveScheduler().run(plan, async (spec) => {
    order.push(`start:${spec.rawId}`)
    if (spec.rawId === 'survey') await release.promise
    order.push(`done:${spec.rawId}`)
    return { phase: 'completed', output: spec.rawId }
  })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(order, ['start:survey'])
  release.resolve()
  const results = await running
  assert.equal(results.get(plan.nodes[0]!.runId)?.phase, 'completed')
  assert.equal(results.get(plan.nodes[1]!.runId)?.phase, 'completed')
  assert.deepEqual(order, ['start:survey', 'done:survey', 'start:build', 'done:build'])
})

test('progress reports running roots while dependents stay queued', async () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] },
    ],
  }), 'del_1')
  const ticks: string[][] = []
  const release = Promise.withResolvers<void>()
  const running = new WaveScheduler().run(plan, async (spec) => {
    if (spec.rawId === 'survey') await release.promise
    return { phase: 'completed', memberId: spec.rawId }
  }, undefined, (snapshot) => {
    ticks.push(plan.nodes.map(node => `${node.rawId}:${snapshot.get(node.runId)?.phase ?? 'missing'}`))
  })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(ticks[0], ['survey:running', 'build:queued'])
  release.resolve()
  const results = await running
  assert.ok(ticks.some(tick => tick[0] === 'survey:running' && tick[1] === 'build:queued'))
  assert.ok(ticks.some(tick => tick[0] === 'survey:completed' && tick[1] === 'build:running'))
  assert.deepEqual(ticks.at(-1), ['survey:completed', 'build:completed'])
  assert.equal(results.get(plan.nodes[0]!.runId)?.phase, 'completed')
  assert.equal(results.get(plan.nodes[1]!.runId)?.phase, 'completed')
})

test('an unknown-after-restart producer skips its dependents', async () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] },
    ],
  }), 'del_1')
  const started: string[] = []
  const results = await new WaveScheduler().run(plan, async (spec) => {
    started.push(spec.rawId)
    return { phase: 'unknown_after_restart' }
  })
  assert.deepEqual(started, ['survey'])
  assert.equal(results.get(plan.nodes[0]!.runId)?.phase, 'unknown_after_restart')
  assert.equal(results.get(plan.nodes[1]!.runId)?.phase, 'skipped')
})

test('an unverified producer skips its dependents', async () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] },
    ],
  }), 'del_1')
  const started: string[] = []
  const results = await new WaveScheduler().run(plan, async (spec) => {
    started.push(spec.rawId)
    return { phase: 'unverified', error: 'no structured result' }
  })
  assert.deepEqual(started, ['survey'])
  assert.equal(results.get(plan.nodes[0]!.runId)?.phase, 'unverified')
  assert.equal(results.get(plan.nodes[1]!.runId)?.phase, 'skipped')
})

test('a blocked producer yields and leaves dependents queued', async () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] },
    ],
  }), 'del_1')
  const started: string[] = []
  const scheduler = new WaveScheduler()
  const results = await scheduler.run(plan, async (spec) => {
    started.push(spec.rawId)
    return { phase: 'blocked', error: 'which option?' }
  })
  assert.deepEqual(started, ['survey'])
  assert.equal(scheduler.yielded, 'decision')
  assert.equal(results.get(plan.nodes[0]!.runId)?.phase, 'blocked')
  assert.equal(results.has(plan.nodes[1]!.runId), false)
})

test('a bind_after_deps node yields until the host binds it', async () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'synth', role: 'synthesizer', task: 'placeholder', depends_on: ['survey'], bind_after_deps: true },
    ],
  }), 'del_1')
  const scheduler = new WaveScheduler()
  const first = await scheduler.run(plan, async () => ({ phase: 'completed', output: 'surveyed' }))
  assert.equal(scheduler.yielded, 'bind')
  assert.equal(first.get(plan.nodes[0]!.runId)?.phase, 'completed')
  assert.equal(first.has(plan.nodes[1]!.runId), false)

  const node = plan.nodes[1]!
  node.bindAfterDeps = false
  node.task = 'Synthesize'
  const second = await scheduler.run(plan, async (spec) => ({
    phase: 'completed',
    output: spec.task,
  }), undefined, undefined, first)
  assert.equal(scheduler.yielded, undefined)
  assert.equal(second.get(plan.nodes[1]!.runId)?.phase, 'completed')
})

test('appendTasksToPlan resolves depends_on against the live graph', () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [{ id: 'survey', role: 'researcher', task: 'Survey' }],
  }), 'del_1')
  const added = appendTasksToPlan(plan, parseDelegateTasks({
    tasks: [{ id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] }],
  }), 'del_1')
  assert.equal(added.length, 1)
  assert.equal(added[0]?.runId, 'del_1_build')
  assert.equal(added[0]?.dependsOn[0], 'del_1_survey')
  assert.equal(plan.waves().length, 2)
})

test('appendTasksToPlan rejects a depends_on that is not on the live graph', () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [{ id: 'survey', role: 'researcher', task: 'Survey' }],
  }), 'del_1')
  assert.throws(() => appendTasksToPlan(plan, parseDelegateTasks({
    tasks: [{ role: 'implementer', task: 'Build', depends_on: ['missing'] }],
  }), 'del_1'), RunPlanError)
})

test('a failed producer skips its dependents', async () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: 'survey', role: 'researcher', task: 'Survey' },
      { id: 'build', role: 'implementer', task: 'Build', depends_on: ['survey'] },
    ],
  }), 'del_1')
  const started: string[] = []
  const results = await new WaveScheduler().run(plan, async (spec) => {
    started.push(spec.rawId)
    return { phase: 'failed', error: 'no' }
  })
  assert.deepEqual(started, ['survey'])
  assert.equal(results.get(plan.nodes[0]!.runId)?.phase, 'failed')
  assert.equal(results.get(plan.nodes[1]!.runId)?.phase, 'skipped')
})

test('chinese raw ids mint path-safe run_ids but keep rawId for display and deps', () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: '计算员', role: '计算员', task: '算乘法' },
      { id: '校验员', role: '校验员', task: '复核', depends_on: ['计算员'] },
    ],
  }), 'del_1')
  for (const node of plan.nodes) {
    assert.match(node.runId, /^[a-zA-Z0-9_-]+$/, `run_id ${node.runId} must be path-safe`)
  }
  assert.equal(plan.nodes[0]?.rawId, '计算员')
  // depends_on 按原始 id 解析后指向铸造出来的 run_id
  assert.equal(plan.nodes[1]?.dependsOn[0], plan.nodes[0]?.runId)
  assert.notEqual(plan.nodes[0]?.runId, plan.nodes[1]?.runId)
})

test('punctuation-only raw ids fall back to index-based slugs without colliding', () => {
  const plan = buildRunPlan(parseDelegateTasks({
    tasks: [
      { id: '计算员', role: 'a', task: 'A' },
      { id: '测试', role: 'b', task: 'B' },
    ],
  }), 'del_1')
  assert.equal(plan.nodes[0]?.runId, 'del_1_n0')
  assert.equal(plan.nodes[1]?.runId, 'del_1_n1')
})
