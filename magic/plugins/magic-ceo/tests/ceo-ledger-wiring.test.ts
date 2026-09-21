/**
 * 账本接线验收（集成层）：**真实的 magic-ledger + 真实的 magic-ceo** 通过 Cordis 服务面互联。
 *
 * 四条命题：
 *   1. 契约在册 + 物证缺失 ⇒ worker 自述"完成"被打成 unverified（账本治的就是这个）。
 *   2. 契约在册 + 物证满足 ⇒ 自述"完成"被接受（账本不是一味否决）。
 *   3. 没带契约的节点 ⇒ 行为与接入账本前完全一致（零回归）。
 *   4. 账本没挂载 ⇒ 带契约的节点也不受影响（可选增强，不是硬依赖）。
 *
 * 运行：node --test plugins/magic-ceo/tests/ceo-ledger-wiring.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply as applyCeo, resetCeoStateForTests } from '../src/index.ts'
import { apply as applyLedger } from '../../magic-ledger/src/index.ts'
import { createMemoryPort as createLedgerPort } from '../../magic-ledger/src/store.ts'
import { createMemoryBacking, createMemoryPort as createCeoPort } from '../src/store/index.ts'

type ToolDef = {
  name: string
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

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

/**
 * 两个插件共用一个「世界」：工具表、服务表、事件监听器都共享，
 * 就像它们在真实 DSH 里挂在同一个 ctx 根上。存储设施各自独立（域不同）。
 */
function makeWorld() {
  const tools = new Map<string, ToolDef>()
  const services = new Map<string, unknown>()
  const listeners: Array<(session: { id: string }, event: unknown) => void> = []
  const started: Array<{ label: string; prompt: string }> = []
  const seqByChild = new Map<string, number>()
  const release = new Map<string, (output?: string, stopReason?: string) => void>()

  const ctx = () => ({
    magicWorkMode: { getMode: () => 'ceo' as const },
    systemPrompt: { section: () => undefined },
    tools: { register: (definition: ToolDef) => { tools.set(definition.name, definition) } },
    subagents: {
      startContinuable: async (spec: {
        label: string
        request: { prompt: Array<{ text?: string }> }
      }) => {
        const id = `member-${String(started.length + 1)}`
        started.push({ label: spec.label, prompt: spec.request.prompt[0]?.text ?? '' })
        release.set(id, (output = 'status: completed\ndone: ok', stopReason = 'completed') => {
          const messageSeq = (seqByChild.get(id) ?? 0) + 1
          seqByChild.set(id, messageSeq)
          for (const listener of listeners) {
            listener({ id }, {
              type: 'assistant/message',
              seq: messageSeq,
              data: { message: { content: [{ type: 'text', text: output }] } },
            })
          }
          const endSeq = messageSeq + 1
          seqByChild.set(id, endSeq)
          for (const listener of listeners) {
            listener({ id }, { type: 'turn/end', seq: endSeq, data: { turn: 1, reason: { kind: stopReason } } })
          }
        })
        return { childId: id }
      },
      sendMessage: async () => 'msg-1',
    },
    provide: (name: string, value: unknown) => {
      services.set(name, value)
      return () => { services.delete(name) }
    },
    get: (name: string) => services.get(name),
    // Cordis 的 effect 语义：setup 立即执行，其返回值才是 disposer。
    effect: (setup: () => unknown) => setup(),
    on: (_event: string, listener: (session: { id: string }, event: unknown) => void) => {
      listeners.push(listener)
    },
  })

  return { tools, services, started, release, ctx }
}

/** 多放几个 microtask，让 open / provide / 契约登记这些 Promise 链跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise((resolve) => { setImmediate(resolve) })
}

const CONTRACT = { required_sections: ['findings'], form: 'prose' }

async function recordEvidence(
  tools: Map<string, ToolDef>,
  args: Record<string, unknown>,
): Promise<void> {
  const tool = tools.get('ledger_record_evidence')
  assert.ok(tool !== undefined, 'ledger_record_evidence 应已注册（账本已挂载）')
  await tool.execute(args)
}

function runIdFromPrompt(prompt: string): string | undefined {
  return /run_id="([^"]+)"/.exec(prompt)?.[1]
}

function firstRun(result: unknown): { runId: string; phase: string } {
  const runs = (result as { runs?: Array<{ runId: string; phase: string }> }).runs ?? []
  assert.ok(runs.length > 0, 'delegate 应返回至少一个 run')
  return runs[0]!
}

async function start(input: {
  withLedger: boolean
  contract?: unknown
  task?: string
  role?: string
}) {
  resetCeoStateForTests()
  const world = makeWorld()
  if (input.withLedger) {
    await applyLedger({ ...world.ctx(), storageDomain: createLedgerPort() } as never)
  }
  applyCeo({ ...world.ctx(), storageDomain: createCeoPort(createMemoryBacking()) } as never)
  await settle()

  const session = journalSession('session-ledger')
  const delegate = world.tools.get('ceo_delegate')
  assert.ok(delegate !== undefined, 'ceo_delegate 应已注册')
  const pending = delegate.execute(
    {
      tasks: [{
        role: input.role ?? 'writer',
        task: input.task ?? 'Write a short note',
        id: 'n1',
        ...input.contract === undefined ? {} : { contract: input.contract },
      }],
    },
    { agent: { session }, callId: 'call-1', signal: new AbortController().signal },
  )
  await settle()
  return { world, pending }
}

test('物证缺失：契约在册时，worker 自述"完成"被打成 unverified', async () => {
  const { world, pending } = await start({ withLedger: true, contract: CONTRACT })
  // worker 没有调 ledger_record_evidence，直接宣称完成。
  world.release.get('member-1')?.()
  const run = firstRun(await pending)
  assert.equal(run.phase, 'unverified', '自述达标但无物证 ⇒ 不算完成')
})

test('物证满足契约：worker 自述"完成"被接受', async () => {
  const { world, pending } = await start({ withLedger: true, contract: CONTRACT })
  const runId = runIdFromPrompt(world.started[0]?.prompt ?? '')
  assert.ok(runId !== undefined, '派活提示词里应给出 run_id，否则 worker 无法写物证')

  await recordEvidence(world.tools, {
    run_id: runId,
    sections_produced: ['findings'],
    landed_paths: [],
    citations: [],
  })
  world.release.get('member-1')?.()
  const run = firstRun(await pending)
  assert.equal(run.phase, 'completed', '物证满足契约 ⇒ 接受自述达标')
})

test('零回归：账本在场但没写契约 ⇒ 软默认契约只催物证，不否决交付', async () => {
  const { world, pending } = await start({ withLedger: true })
  const prompt = world.started[0]?.prompt ?? ''
  assert.match(prompt, /ledger_record_evidence/, '默认契约要让 worker 知道要交物证')
  world.release.get('member-1')?.()
  const run = firstRun(await pending)
  assert.equal(run.phase, 'completed', '软默认契约不带任何要求 ⇒ 不可能否决自述达标')
})

test('显式契约的要求会原样写进 worker 提示词（否则契约永远满足不了）', async () => {
  const { world } = await start({
    withLedger: true,
    contract: { form: 'files', required_sections: ['findings', 'risks'], artifacts: ['dist/report.md'] },
  })
  const prompt = world.started[0]?.prompt ?? ''
  assert.match(prompt, /Required sections/)
  assert.match(prompt, /findings/)
  assert.match(prompt, /risks/)
  assert.match(prompt, /Required artifacts/)
  assert.match(prompt, /dist\/report\.md/)
  assert.match(prompt, /must exist on disk/, 'files 形态要讲清"必须真落盘"')
})

test('默认契约会登记进账本（机制真的武装上了）', async () => {
  const { world } = await start({ withLedger: true })
  const runId = runIdFromPrompt(world.started[0]?.prompt ?? '')
  assert.ok(runId !== undefined)
  const ledger = world.services.get('magicLedger') as
    | { getContract: (id: string) => { requiredSections: string[]; artifacts: string[]; form: string } | undefined }
    | undefined
  assert.ok(ledger !== undefined, 'magicLedger 服务应已 provide')
  const stored = ledger.getContract(runId)
  assert.ok(stored !== undefined, '默认契约应已按 runId 登记')
  assert.deepEqual(stored.requiredSections, [])
  assert.deepEqual(stored.artifacts, [])
})

test('账本没挂载时，提示词不提账本工具（不说一套做不到的话）', async () => {
  const { world } = await start({ withLedger: false })
  const prompt = world.started[0]?.prompt ?? ''
  assert.doesNotMatch(prompt, /ledger_record_evidence/)
  assert.doesNotMatch(prompt, /delivery contract/)
})

test('可选增强：账本没挂载时，带契约的节点行为不受影响', async () => {
  const { world, pending } = await start({ withLedger: false, contract: CONTRACT })
  world.release.get('member-1')?.()
  const run = firstRun(await pending)
  assert.equal(run.phase, 'completed', '账本缺失 ⇒ 退回原有判定，不误伤、不报错')
})
