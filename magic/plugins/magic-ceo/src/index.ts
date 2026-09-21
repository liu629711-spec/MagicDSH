import { appendTasksToPlan, buildRunPlan, parseDelegateTasks, type DelegateTask } from './builder.ts'
import {
  applyEvidenceVerdict,
  classifyWorkerDelivery,
  contractBrief,
  DEFAULT_DELIVERY_CONTRACT,
  type ContractBrief,
  type EvidenceVerdictView,
} from './delivery.ts'
import {
  appendCeoMemberResult,
  appendCeoPlan,
  appendCeoPlanRevision,
  appendCeoRunPhase,
  appendCeoRunProgress,
  appendRunJournal,
  appendCeoMemberUsage,
  appendCeoMemberHalted,
  appendCeoMemberRedirected,
  appendCeoCheckpoint,
  appendCeoMemberContext,
  currentTurn,
  journalRuns,
  latestCeoPlan,
  latestCeoRunJournal,
  memberResultsOf,
  unknownAfterRestartRuns,
  type CeoContextChannel,
  type CeoPlanData,
  type CeoTokenUsage,
  type JournalSession,
} from './journal.ts'
import { RunPlan, type RunSpec, type RunState } from './plan.ts'
import {
  attachRunProcessMirror,
  ingestChildSessionEvent,
  resetProcessMirrorsForTests,
  type ChildSessionEvent,
} from './process.ts'
import { ingestChildTurnEvent, resetResidencyForTests, waitForChildTurn } from './residency.ts'
import {
  createDshPort,
  createMemoryPort,
  openCeoStore,
  type CeoStore,
  type DshStorageDomainFacility,
  type PersistedMember,
  type PersistedPlan,
} from './store/index.ts'
import { haltRun, isRunHalted, WaveScheduler, type WaveYieldReason } from './wave.ts'

export const name = 'magic-ceo'

/**
 * 依赖的 Cordis 服务。
 *
 * `storageDomain` 必须声明：Cordis 下访问未 inject 的服务属性会直接抛错
 * （`cannot get property "storageDomain" without inject`）。声明后它与
 * web profile 的 storage 三件套（`bundle/base/cordis.patch.yml:145-154`）绑定；
 * 单元测试直接调 `apply`，不走 DI，走代码里的降级分支。
 */
export const inject = ['tools', 'subagents', 'systemPrompt', 'magicWorkMode', 'storageDomain']

export interface CeoMember {
  runId: string
  rawId: string
  memberId?: string
  /** 官方名册名（半改道后经 agentTeams 派出的成员才有；steer/halt 按名路由）。 */
  officialName?: string
  parentSessionId: string
  role: string
  task: string
  dependsOn: string[]
  phase: RunState['phase']
  createdAt: string
  steer?: string
  bindAfterDeps?: boolean
  turnSeq?: number
}

interface MagicWorkModeService {
  getMode: (sessionId: string, session?: JournalSession) => 'agent' | 'ceo'
}

type PromptAssembleContext = {
  agent?: { session?: { id?: string } }
}

function sessionIdOf(context: PromptAssembleContext | undefined): string | undefined {
  const id = context?.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

const CEO_GRAPH_RULES = [
  '- ceo_delegate takes a tasks[] run graph: each item is role + task. Independent tasks run in parallel; producer→consumer tasks use depends_on.',
  '- Do not start a dependent task yourself. The scheduler starts it only after its depends_on nodes have finished.',
  '- task is the work itself: goal, boundary, and acceptance. Do not paste JSON schemas, output templates, or “return exactly this JSON” instructions into task.',
  '- Members already return structured results (status, done, not_done, artifacts, evidence, risks_or_blockers, next, user_decisions). You assemble one delivery. Never rewrite a member failure, blocker, or unverified return as success.',
  '- Workers are always asked to file evidence via ledger_record_evidence. To hold a node to named sections or on-disk artifacts, add contract { required_sections, artifacts, form } to that task: the worker is then told those exact requirements, and a "completed" claim counts only if the evidence matches. Without a contract, acceptance is not enforced.',
  '- Members stay resident after a node finishes. Do not spawn a new worker for the same seat unless you replace that node.',
  '- When a member returns user_decisions, the graph yields. Ask the user yourself with ask_user_question, then call ceo_replan with continue. Do not rewrite their work as success.',
  '- When the graph yields (a member blocked or a bind_after_deps node ready), report that state to the user in your reply before doing anything else. If the tool receipts fail so you cannot see the graph, say so and ask before finishing the delivery yourself — silently replacing the graph with manual work is forbidden.',
  '- A bind_after_deps node waits until its producers finish, then the graph yields. Call ceo_replan binds to finalize it before it starts.',
  '- Use ceo_replan on the same graph to bind, steer queued nodes, add nodes, continue a blocked member, replace a failed node, or stop the remaining tail. Do not call ceo_delegate again for that graph.',
]

export function ceoModePrompt(mode: 'agent' | 'ceo'): string {
  if (mode === 'ceo') {
    return [
      'CEO rules:',
      '- This session is in CEO mode now. You are the manager of this turn, not a solo researcher.',
      '- Breadth research must be delegated on the first action:',
      '  - market / industry / competitive research',
      '  - surveys that cover multiple regions, products, or sources (including domestic vs overseas / 海内外)',
      '  - comparison of ≥2 named entities, markets, styles, or options',
      '- For those tasks: first stream a useful analysis of scope, evidence gaps, acceptance, and division of labor. Then call ceo_plan with the proposed tasks[], and only then call ceo_delegate with that identical graph. Do not perform breadth web research yourself before delegation.',
      '- If the user names N (≥2) entities or markets, create at least N tasks (one per entity). An optional 汇总 node may depend_on them. Do not assign one member the whole comparison.',
      '- role is the unique seat name shown on the canvas. Name it after this member\'s work package in Chinese, such as 国内市场, 海外市场, 竞品对比. Do not reuse generic job types like 调研, 汇总, research, or synthesis, and do not give two members the same role.',
      '- Answer yourself only for small talk, a single fact, a short follow-up about this conversation, or a brief explanation that needs no new research.',
      ...CEO_GRAPH_RULES,
    ].join('\n')
  }
  return [
    'CEO rules:',
    '- This session is in agent mode. Do not call ceo_delegate or ceo_replan.',
    '- Use ceo_delegate only when this session is in CEO mode.',
    ...CEO_GRAPH_RULES,
  ].join('\n')
}

interface ParentAgent {
  session: JournalSession & { id: string }
}

interface ContinuableStart {
  childId: string
}

interface LiveGraph {
  plan: RunPlan
  specs: Map<string, RunSpec>
  states: Map<string, RunState>
  members: CeoMember[]
  callId: string
  turn: number
  prefix: string
}

const membersByParent = new Map<string, CeoMember[]>()
const plansByParent = new Map<string, CeoPlanData>()
const graphsByParent = new Map<string, LiveGraph>()

/** Live abort controllers per (parentSessionId, runId) so a single member can be
 *  stopped without touching the rest of the graph. */
const abortsByParent = new Map<string, Map<string, AbortController>>()

/** Cumulative token usage per (parentSessionId, runId). */
const usageByParent = new Map<string, Map<string, CeoTokenUsage>>()

/** Context channels fed to each member's prompt, with the size each carried. */
const channelsByParent = new Map<string, Map<string, CeoContextChannel[]>>()

// ── 持久快照：`magic_ceo` 域（W1 接线）─────────────────────────────────────
// 6 个内存 Map 仍是热路径；`magic_ceo` 域是它们背后的结构化快照，让重启后
// **直接读到状态**，而不是靠 session 事件回放"猜"。两条路并存：事件日志
// 提供审计与兜底，域提供快照与离线查询。
//
// `storageDomain` 缺失（单元测试、未加载 storage 的 profile）时降级为内存
// 端口，行为与接线前完全一致，因此现有测试不需要任何改动。
let ceoStore: CeoStore | undefined
let storeGeneration = 0
let storePending: Array<(store: CeoStore) => void> = []

/**
 * 初始化存储域并返回卸载函数。
 * 用 generation 守卫：测试连续 apply 时，在途的旧 open 不会把域写回。
 */
function initCeoStore(host: { storageDomain?: DshStorageDomainFacility }): () => void {
  const generation = ++storeGeneration
  storePending = []
  ceoStore = undefined
  const port = host.storageDomain === undefined ? createMemoryPort() : createDshPort(host)
  void openCeoStore(port).then((store) => {
    if (generation !== storeGeneration) {
      void store.close()
      return
    }
    ceoStore = store
    console.log('[magic-ceo] magic_ceo storage domain ready')
    const queued = storePending
    storePending = []
    for (const run of queued) run(store)
  }).catch((error: unknown) => {
    if (generation !== storeGeneration) return
    ceoStore = undefined
    // 不静默：域开不起来必须可见，否则会退化成"以为在持久化、其实没有"。
    console.warn('[magic-ceo] magic_ceo storage domain unavailable; falling back to in-process state', error)
  })
  return () => {
    const current = ceoStore
    ceoStore = undefined
    storePending = []
    storeGeneration += 1
    if (current !== undefined) void current.close()
  }
}

/** 域就绪前排队、就绪后立刻执行，保证不丢写。 */
function withStore(run: (store: CeoStore) => void): void {
  if (ceoStore !== undefined) {
    run(ceoStore)
    return
  }
  storePending.push(run)
}

function toPersistedMember(member: CeoMember): PersistedMember {
  return {
    runId: member.runId,
    rawId: member.rawId,
    parentSessionId: member.parentSessionId,
    role: member.role,
    task: member.task,
    dependsOn: [...member.dependsOn],
    phase: member.phase,
    createdAt: member.createdAt,
    ...member.memberId === undefined ? {} : { memberId: member.memberId },
    ...member.officialName === undefined ? {} : { officialName: member.officialName },
    ...member.steer === undefined ? {} : { steer: member.steer },
    ...member.bindAfterDeps === undefined ? {} : { bindAfterDeps: member.bindAfterDeps },
    ...member.turnSeq === undefined ? {} : { turnSeq: member.turnSeq },
  }
}

function fromPersistedMember(record: PersistedMember): CeoMember {
  const member: CeoMember = {
    runId: record.runId,
    rawId: record.rawId,
    parentSessionId: record.parentSessionId,
    role: record.role,
    task: record.task,
    dependsOn: [...record.dependsOn],
    phase: record.phase as CeoMember['phase'],
    createdAt: record.createdAt,
  }
  if (record.memberId !== undefined) member.memberId = record.memberId
  if (record.officialName !== undefined) member.officialName = record.officialName
  if (record.steer !== undefined) member.steer = record.steer
  if (record.bindAfterDeps !== undefined) member.bindAfterDeps = record.bindAfterDeps
  if (record.turnSeq !== undefined) member.turnSeq = record.turnSeq
  return member
}

function toPersistedPlan(plan: CeoPlanData): PersistedPlan {
  return {
    turn: plan.turn,
    planId: plan.planId,
    version: plan.version,
    summary: plan.summary,
    analysis: plan.analysis,
    ...plan.teamBrief === undefined ? {} : { teamBrief: plan.teamBrief },
    tasks: plan.tasks.map(task => ({
      ...task.id === undefined ? {} : { id: task.id },
      role: task.role,
      task: task.task,
      dependsOn: [...task.dependsOn],
      ...task.bindAfterDeps === true ? { bindAfterDeps: true } : {},
    })),
  }
}

function fromPersistedPlan(record: PersistedPlan): CeoPlanData {
  return {
    turn: record.turn,
    planId: record.planId,
    version: record.version,
    summary: record.summary,
    analysis: record.analysis,
    ...record.teamBrief === undefined ? {} : { teamBrief: record.teamBrief },
    tasks: record.tasks.map(task => ({
      ...task.id === undefined ? {} : { id: task.id },
      role: task.role,
      task: task.task,
      dependsOn: [...task.dependsOn],
      ...task.bindAfterDeps === true ? { bindAfterDeps: true } : {},
    })),
  }
}

function memberAbortMap(parentSessionId: string): Map<string, AbortController> {
  const existing = abortsByParent.get(parentSessionId)
  if (existing !== undefined) return existing
  const created = new Map<string, AbortController>()
  abortsByParent.set(parentSessionId, created)
  return created
}

function usageMapOf(parentSessionId: string): Map<string, CeoTokenUsage> {
  const existing = usageByParent.get(parentSessionId)
  if (existing !== undefined) return existing
  const created = new Map<string, CeoTokenUsage>()
  usageByParent.set(parentSessionId, created)
  return created
}

function channelsMapOf(parentSessionId: string): Map<string, CeoContextChannel[]> {
  const existing = channelsByParent.get(parentSessionId)
  if (existing !== undefined) return existing
  const created = new Map<string, CeoContextChannel[]>()
  channelsByParent.set(parentSessionId, created)
  return created
}

function addUsage(parentSessionId: string, memberId: string, delta: CeoTokenUsage): void {
  const map = usageMapOf(parentSessionId)
  const current = map.get(memberId) ?? { inputTokens: 0, outputTokens: 0 }
  map.set(memberId, {
    inputTokens: current.inputTokens + delta.inputTokens,
    outputTokens: current.outputTokens + delta.outputTokens,
    ...current.totalTokens !== undefined || delta.totalTokens !== undefined
      ? { totalTokens: (current.totalTokens ?? 0) + (delta.totalTokens ?? 0) }
      : {},
    ...current.cacheReadTokens !== undefined || delta.cacheReadTokens !== undefined
      ? { cacheReadTokens: (current.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0) }
      : {},
    ...current.cacheWriteTokens !== undefined || delta.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0) }
      : {},
    ...current.reasoningTokens !== undefined || delta.reasoningTokens !== undefined
      ? { reasoningTokens: (current.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0) }
      : {},
  })
}

/** Numeric field with a safe integer fallback; usage fields can be 0. */
function usageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function usageFromValue(value: unknown): CeoTokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const inputTokens = usageNumber(record.inputTokens)
  const outputTokens = usageNumber(record.outputTokens)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const usage: CeoTokenUsage = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }
  const total = usageNumber(record.totalTokens)
  if (total !== undefined) usage.totalTokens = total
  const cacheRead = usageNumber(record.cacheReadTokens)
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  const cacheWrite = usageNumber(record.cacheWriteTokens)
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  const reasoning = usageNumber(record.reasoningTokens)
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  return usage
}

/** Member session ids that belong to each parent graph, so usage events fired on
 *  the child session can be attributed back to (parent, runId). */
const membersByChildId = new Map<string, CeoMember>()

function trackMemberChild(member: CeoMember, childId: string): void {
  member.memberId = childId
  membersByChildId.set(childId, member)
}

function ingestChildUsageEvent(_sessionId: string, event: ChildSessionEvent): void {
  if (event.type !== 'assistant/message') return
  const data = event.data
  const message = typeof data === 'object' && data !== null
    ? (data as { message?: { usage?: unknown } }).message
    : undefined
  if (message === undefined || typeof message !== 'object') return
  const usage = usageFromValue(message.usage)
  if (usage === undefined) return
  const member = membersByChildId.get(_sessionId)
  if (member === undefined) return
  addUsage(member.parentSessionId, member.runId, usage)
}

function membersOf(parentSessionId: string): CeoMember[] {
  const existing = membersByParent.get(parentSessionId)
  if (existing !== undefined) return existing
  const created: CeoMember[] = []
  // 先取持久快照：重启后直接读到成员，不必等事件回放。
  if (ceoStore !== undefined) {
    for (const record of ceoStore.membersOf(parentSessionId)) created.push(fromPersistedMember(record))
  }
  membersByParent.set(parentSessionId, created)
  return created
}

function wrapMemberPrompt(
  role: string,
  task: string,
  upstream: ReadonlyMap<string, RunState>,
  specs: ReadonlyMap<string, RunSpec>,
  extra?: string,
  teamBrief?: string,
  channels?: CeoContextChannel[],
  contractRunId?: string,
  contract?: ContractBrief,
): string {
  const lines = [
    'You are a worker on a CEO run graph.',
    `Role: ${role}`,
    `Task: ${task}`,
    'You are not a reduced tool. Complete this node with the same capabilities a session lead would use.',
    'send_message is optional and only for an injected, resolvable agent_id; never rely on it for delivery. Your final assistant message is the delivery.',
    'Write the final message for a human reader: a short readable report in normal prose/markdown that stands on its own (findings, key numbers with sources, caveats).',
    'End the SAME final message with a compact structured trailer so the graph can settle. The trailer is plain labeled lines in English, exactly these keys, no markdown, no code fence, no extra commentary:',
    'status: completed | blocked | failed | partial',
    'If you cannot produce that trailer, say so in the body. Do not claim success. A finish without a recognizable trailer is recorded as unverified, not completed.',
    'done: one or two sentences on what you finished',
    'not_done: what remains',
    'artifacts: files or outputs',
    'evidence: how it was verified',
    'risks_or_blockers: risks, conflicts, or blockers',
    'next: recommended next step',
    'user_decisions: questions only the user can answer, or empty',
    'Do not put the report body into done. Do not wrap the trailer in JSON. Do not claim success if the work failed or is incomplete.',
  ]
  if (contract !== undefined) {
    lines.push(
      '',
      'This node carries a delivery contract. Acceptance is decided by structured evidence, not by your prose trailer.',
      `When the work is done, call ledger_record_evidence with run_id="${contractRunId ?? ''}" and fill landed_paths, sections_produced, and citations (note is optional).`,
    )
    if (contract.requiredSections.length > 0) {
      lines.push(
        `Required sections — list these exact names in sections_produced: ${contract.requiredSections.join(', ')}`,
      )
    }
    if (contract.artifacts.length > 0) {
      lines.push(
        `Required artifacts — you MUST actually write these and put the real paths in landed_paths: ${contract.artifacts.join(', ')}`,
      )
    }
    if (contract.form === 'files') {
      lines.push('This is a files delivery: the listed artifacts must exist on disk, not only in your report.')
    }
    if (contract.citationMode === 'two_phase') {
      lines.push('Citations are checked in two_phase mode: only already-verified citation ids count.')
    }
    lines.push('A "completion" claim without matching evidence is recorded as unverified.')
  }
  if (teamBrief !== undefined && teamBrief.trim() !== '') {
    lines.push('', 'Shared team brief:', teamBrief.trim())
  }
  if (extra !== undefined && extra.trim() !== '') {
    lines.push('', 'Steer note (mid-flight direction from the CEO):', extra.trim())
  }
  if (upstream.size > 0) {
    lines.push('', 'Upstream results:')
    for (const [runId, state] of upstream) {
      const spec = specs.get(runId)
      lines.push(`- ${spec?.role ?? runId} (${runId}) [${state.phase}]`)
      if ((state.output ?? '').trim() !== '') lines.push(state.output!.trim())
    }
  }
  if (channels !== undefined && channels.length > 0) {
    lines.push('', 'What this prompt contained (channel: chars):')
    for (const channel of channels) {
      lines.push(`- ${channel.channel}: ${String(channel.chars)}${channel.truncated ? ' (truncated)' : ''}`)
    }
  }
  return lines.join('\n')
}

export function listCeoMembers(parentSessionId: string): readonly CeoMember[] {
  return membersOf(parentSessionId)
}

const restampedJournals = new Set<string>()

function hasLiveMembers(sessionId: string): boolean {
  return (membersByParent.get(sessionId) ?? []).some(member =>
    member.phase === 'queued' || member.phase === 'running' || member.phase === 'blocked',
  )
}

function freezeInFlightAfterRestart(session: JournalSession & { id?: string }): void {
  const sessionId = session.id
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (restampedJournals.has(sessionId) || hasLiveMembers(sessionId)) return
  const journal = latestCeoRunJournal(session)
  if (journal === undefined) {
    restampedJournals.add(sessionId)
    return
  }
  const { runs, changed } = unknownAfterRestartRuns(journal, session)
  restampedJournals.add(sessionId)
  if (!changed) return
  appendRunJournal(session, { ...journal, runs })
}

export function resetCeoStateForTests(): void {
  // 作废在途 open，避免上一个用例的域写回本次。
  storeGeneration += 1
  storePending = []
  ceoStore = undefined
  membersByParent.clear()
  plansByParent.clear()
  graphsByParent.clear()
  restampedJournals.clear()
  abortsByParent.clear()
  usageByParent.clear()
  channelsByParent.clear()
  membersByChildId.clear()
  resetProcessMirrorsForTests()
  resetResidencyForTests()
}

function planOf(parent: ParentAgent): CeoPlanData | undefined {
  freezeInFlightAfterRestart(parent.session)
  const parentSessionId = parent.session.id
  const cached = plansByParent.get(parentSessionId)
  if (cached !== undefined) return cached
  // 先取持久快照，再退回事件回放。
  const persisted = ceoStore?.getPlan(parentSessionId)
  if (persisted !== undefined) {
    const fromStore = fromPersistedPlan(persisted)
    plansByParent.set(parentSessionId, fromStore)
    return fromStore
  }
  const restored = latestCeoPlan(parent.session)
  if (restored !== undefined) plansByParent.set(parentSessionId, restored)
  return restored
}

function isComplexTask(task: { role: string; task: string; dependsOn: string[] }, count: number): boolean {
  if (count >= 3 || task.dependsOn.length > 0) return true
  return /research|survey|market|compare|competitive|调研|研究|市场|比较|竞品|多来源|多视角/i.test(
    `${task.role} ${task.task}`,
  )
}

function taskFingerprint(tasks: readonly { role: string; task: string; dependsOn: string[]; bindAfterDeps?: boolean | undefined }[]): string {
  return JSON.stringify(tasks.map(task => ({
    role: task.role.trim(),
    task: task.task.trim(),
    dependsOn: [...task.dependsOn].sort(),
    bindAfterDeps: task.bindAfterDeps === true,
  })))
}

const TERMINAL = new Set(['completed', 'failed', 'skipped', 'cancelled', 'unverified', 'unknown_after_restart'])

function restoreGraph(parent: ParentAgent): LiveGraph | undefined {
  const cached = graphsByParent.get(parent.session.id)
  if (cached !== undefined) return cached
  const journal = latestCeoRunJournal(parent.session)
  if (journal === undefined) return undefined
  const plan = new RunPlan()
  const specs = new Map<string, RunSpec>()
  const states = new Map<string, RunState>()
  const existing = membersOf(parent.session.id)
  const createdAt = new Date().toISOString()
  const results = memberResultsOf(parent.session)
  for (const run of journal.runs) {
    const spec: RunSpec = {
      runId: run.runId,
      rawId: run.rawId,
      role: run.role,
      task: run.task,
      dependsOn: run.dependsOn,
      ...run.bindAfterDeps === true ? { bindAfterDeps: true } : {},
    }
    plan.add(spec)
    specs.set(spec.runId, spec)
    const recorded = results.get(run.runId)
    const recordedMemberId = run.memberId ?? recorded?.memberId
    const recordedOutput = recorded?.output
    states.set(spec.runId, {
      phase: run.phase,
      ...recordedMemberId === undefined ? {} : { memberId: recordedMemberId },
      ...recordedOutput === undefined || recordedOutput === '' ? {} : { output: recordedOutput },
    })
    if (!existing.some(item => item.runId === run.runId)) {
      existing.push({
        runId: run.runId,
        rawId: run.rawId,
        parentSessionId: parent.session.id,
        role: run.role,
        task: run.task,
        dependsOn: run.dependsOn,
        phase: run.phase,
        createdAt,
        ...run.memberId === undefined ? {} : { memberId: run.memberId },
        ...run.bindAfterDeps === true ? { bindAfterDeps: true } : {},
      })
    }
  }
  const prefix = journal.runs[0]?.runId.replace(/_[^_]+$/, '') ?? `del_${String(Date.now())}`
  const graph: LiveGraph = {
    plan,
    specs,
    states,
    members: existing,
    callId: journal.callId,
    turn: journal.turn,
    prefix,
  }
  graphsByParent.set(parent.session.id, graph)
  return graph
}

function runOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      runs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'string' },
            role: { type: 'string' },
            task: { type: 'string' },
            memberId: { type: 'string' },
            phase: { type: 'string' },
          },
          required: ['runId', 'role', 'task', 'phase'],
        },
      },
      yielded: { type: 'string' },
    },
    required: ['runs'],
  }
}

function renderRuns(value: {
  runs?: Array<{ runId: string; role: string; task: string; memberId?: string; phase: string }>
  yielded?: string
}): Array<{ type: 'text'; text: string }> {
  const lines = (value.runs ?? []).map(run => {
    const member = run.memberId === undefined ? '' : ` as member ${run.memberId}`
    return `delegated ${run.role} (${run.runId})${member} ${run.phase}`
  })
  if (value.yielded !== undefined && value.yielded !== '') {
    lines.push(`CEO graph yielded (${value.yielded})`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

type DelegateResult = {
  runs: Array<{ runId: string; role: string; task: string; memberId?: string; phase: string }>
  yielded?: WaveYieldReason
}

/** `magicLedger` 服务面（Magic 内部跨插件服务，契约内核 §2.1.1）。 */
export interface MagicLedgerPort {
  /** 登记一份交付契约（按 contractId 幂等写入）。 */
  putContract(contractId: string, contract: unknown): Promise<void>
  /** 基于契约 + 物证 + 地面事实验收；无契约时返回 undefined（表示无可验之物）。 */
  verify(
    runId: string,
    contractId: string,
    ground: { landedPaths: string[]; verifiedCitationIds: string[] },
  ): EvidenceVerdictView | undefined
}

/**
 * 可选读取账本服务：未挂载或形状不符时返回 undefined，调用方据此退回原行为。
 *
 * 刻意不写进 `inject`：Cordis 的 inject 是硬依赖，账本缺失会导致 CEO 整棵树不激活。
 * 也刻意**不在 apply 时缓存**：`ctx.get` 是运行时读取，账本比 CEO 晚加载也能拿到，
 * 否则插件加载顺序会静默决定账本是否生效。
 */
function readLedger(host: { get?: (name: string) => unknown }): MagicLedgerPort | undefined {
  const value = host.get?.('magicLedger')
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<MagicLedgerPort>
  if (typeof candidate.putContract !== 'function' || typeof candidate.verify !== 'function') return undefined
  return candidate as MagicLedgerPort
}

/**
 * 官方 Agent Teams 服务面（experimental，契约内核 §2.1.1）。只声明 Magic 用到的
 * 最小子集，靠鸭子类型访问，**不 import 官方包源码** —— 官方包声明 `private: true`
 * 且明确「不承诺稳定性」，直接依赖会把 Magic 绑死在它的发布节奏上。
 */
export interface AgentTeamsPort {
  /** 在官方名册里派一名成员（创建后 name / description / context 不可变）。 */
  spawnTeammate(
    caller: unknown,
    request: {
      name: string
      description: string
      prompt: unknown[]
      context: 'fresh' | 'fork'
      provider: string
      signal: AbortSignal
    },
  ): Promise<unknown>
  /**
   * 投一条**持久**消息：目标成员当前离线时排队，而不是丢弃。
   * 官方请求只有 target / content / signal 三个字段——早先草稿里的投递模式字段
   * 已被官方删除（DSH packages/experimental/agent-team/src/types.ts
   * SendTeamMessageRequest），声明必须与官方形状一致。
   * 投递底层是 ctx.subagents 的 steer（mailbox.ts dispatchOnce →
   * steerHostSubagentPrompt），成员在线立即投、离线持久排队重试。
   */
  sendMessage(
    caller: unknown,
    request: { target: string; content: unknown[]; signal: AbortSignal },
  ): Promise<unknown>
  /** 打断一个在册成员的当前回合（按官方名册名路由），不清空其待投信箱。 */
  interrupt?(caller: unknown, targetName: string): unknown
}

/**
 * 官方名册成员名：lower-kebab-case、≤64 字符、不得为 "lead"
 * （agent-team/src/roster.ts memberName）。由 runId 转换而来 —— runId 在一个
 * 会话的图内唯一（前缀含毫秒时间戳），所以名册名天然唯一。
 */
export function officialMemberNameOf(runId: string): string {
  const kebab = `m-${runId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return kebab.slice(0, 64)
}

/**
 * 从 spawnTeammate 结果里取成员的子代理会话 id。官方把成员 id 直接当
 * continuable childId 用（roster.ts spawnAdmitted 把 childId 传给
 * startContinuable），所以拿到 id 就能接进 residency 的回合等待。
 */
export function officialMemberIdOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const member = (result as { member?: unknown }).member
  if (typeof member !== 'object' || member === null) return undefined
  const id = (member as { id?: unknown }).id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 可选读取官方 Agent Teams 服务：未挂载或形状不符时返回 undefined。
 *
 * 准则与 `readLedger` 完全一致：不写进 `inject`（硬依赖会让 CEO 整棵树不激活），
 * 也不在 apply 时缓存（`ctx.get` 是运行时读取，加载顺序不决定可用性）。
 */
export function readAgentTeams(host: { get?: (name: string) => unknown }): AgentTeamsPort | undefined {
  const value = host.get?.('agentTeams')
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<AgentTeamsPort>
  if (typeof candidate.spawnTeammate !== 'function' || typeof candidate.sendMessage !== 'function') {
    return undefined
  }
  return candidate as AgentTeamsPort
}

/** 把本批节点携带的交付契约登记进账本（无契约 / 账本未挂载时跳过）。 */
function registerContracts(ledger: MagicLedgerPort | undefined, nodes: readonly RunSpec[]): void {
  if (ledger === undefined) return
  for (const node of nodes) {
    if (node.contract === undefined) continue
    void Promise.resolve(ledger.putContract(node.runId, node.contract)).catch(() => {
      console.warn(`[magic-ceo] failed to register delivery contract for ${node.runId}`)
    })
  }
}

/**
 * 账本在场时，给没写契约的节点补一份软默认契约（只催物证，不追加任何要求）。
 *
 * 账本不在场时原样返回 —— 否则 worker 会被告知去调一个并不存在的工具。
 * 显式写了契约的节点不动：那是调用方想要的严格要求。
 */
function withDefaultContract(
  tasks: readonly DelegateTask[],
  ledger: MagicLedgerPort | undefined,
): readonly DelegateTask[] {
  if (ledger === undefined) return tasks
  return tasks.map(task => task.contract === undefined
    ? { ...task, contract: DEFAULT_DELIVERY_CONTRACT }
    : task)
}

/**
 * 用账本物证复核一次成员交付。
 *
 * `landedPaths` 传空表示"本批未做真实落盘核对" —— 按 delivery.ts 的规则，
 * 未核对不参与否决，避免 files 形态契约在无 fs 事实时误伤全部交付。
 */
function evidenceVerdictOf(
  ledger: MagicLedgerPort | undefined,
  node: RunSpec,
): { verdict: EvidenceVerdictView; landedPathsChecked: boolean } | undefined {
  if (ledger === undefined || node.contract === undefined) return undefined
  try {
    const verdict = ledger.verify(node.runId, node.runId, { landedPaths: [], verifiedCitationIds: [] })
    if (verdict === undefined) return undefined
    return { verdict, landedPathsChecked: false }
  } catch (error) {
    console.warn(`[magic-ceo] ledger verify failed for ${node.runId}`, error)
    return undefined
  }
}

export function apply(ctx: {
  tools: {
    register: (definition: {
      name: string
      description: string
      parameters: Record<string, unknown>
      output: {
        schema: Record<string, unknown>
        render: (args: unknown, value: {
          runs?: Array<{ runId: string; role: string; task: string; memberId?: string; phase: string }>
          planId?: string
          status?: string
          yielded?: string
        }) => Array<{ type: 'text'; text: string }>
      }
      isConcurrencySafe?: () => boolean
      execute: (args: unknown, exec: {
        agent?: ParentAgent
        callId?: string
        signal: AbortSignal
      }) => Promise<{
        runs?: Array<{ runId: string; role: string; task: string; memberId?: string; phase: string }>
        planId?: string
        status?: string
        yielded?: string
      }>
    }) => unknown
  }
  subagents: {
    startContinuable: (spec: {
      provider: string
      label: string
      request: {
        prompt: Array<{ type: 'text'; text: string }>
        parent: ParentAgent
      }
      signal: AbortSignal
    }) => Promise<ContinuableStart>
    sendMessage: (
      sender: ParentAgent,
      targetId: string,
      content: Array<{ type: 'text'; text: string }>,
      options: { signal: AbortSignal },
    ) => Promise<string>
    /** DSH subagent control: interrupt one live child's current turn. */
    interrupt?: (targetSessionId: string, authority: { kind: 'ancestor'; agent: ParentAgent }) => void
  }
  systemPrompt: {
    section: (section: {
      name: string
      order: number
      text: string | ((context?: PromptAssembleContext) => string)
    }) => unknown
  }
  magicWorkMode: MagicWorkModeService
  /** DSH 存储域设施（契约内核 §2.2）。缺失时降级为进程内存端口，行为不变。 */
  storageDomain?: DshStorageDomainFacility
  /**
   * 无需 `inject` 的服务读取（Cordis `ctx.get`）。
   * 用于可选增强：账本未挂载时拿到 undefined，CEO 行为与接入前完全一致。
   */
  get?: (name: string) => unknown
  /** 插件卸载钩子（契约内核 §3.4）。Cordis effect(setup)：setup 立即执行，其返回值可为 disposer。 */
  effect?: (setup: () => void | Promise<void> | (() => void)) => unknown
  on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown
}) {
  console.log('[magic-ceo] plugin loaded')
  const disposeCeoStore = initCeoStore(ctx)
  // 一次性可观测信号：账本服务在**运行时**是否可见 —— 它决定物证验收是否真的生效。
  // 用 ctx.get 在启动后读取（而非 apply 时机），因为账本可能比 CEO 晚加载。
  const ledgerProbe = setTimeout(() => {
    console.log(`[magic-ceo] ledger service ${
      readLedger(ctx) === undefined ? 'absent (evidence check off)' : 'available (evidence check on)'
    }`)
    console.log(`[magic-ceo] agent-team service ${
      readAgentTeams(ctx) === undefined
        ? 'absent (delegation stays on dsh subagents)'
        : 'available (official roster reachable)'
    }`)
  }, 1500)
  ledgerProbe.unref?.()
  // Cordis 的 effect 语义是 `effect(setup)`：setup **立即执行**，其返回值才是 disposer。
  // 直接传 disposer 会被当作 setup 当场调用（域会立刻作废）。
  ctx.effect?.(() => disposeCeoStore)

  ctx.on?.('session/event', (session, event) => {
    const subject = session as JournalSession & { id?: string }
    if (typeof subject.id !== 'string') return
    const childEvent = event as ChildSessionEvent
    ingestChildSessionEvent(subject.id, childEvent)
    ingestChildTurnEvent(subject.id, childEvent)
    ingestChildUsageEvent(subject.id, childEvent)
    freezeInFlightAfterRestart(subject)
  })

  ctx.systemPrompt.section({
    name: 'magic-ceo',
    order: 255,
    text: (context) => {
      const session = context?.agent?.session as (JournalSession & { id?: string }) | undefined
      if (session !== undefined) freezeInFlightAfterRestart(session)
      const sessionId = sessionIdOf(context)
      const mode = sessionId === undefined ? 'agent' : ctx.magicWorkMode.getMode(sessionId, session)
      return ceoModePrompt(mode)
    },
  })

  async function driveGraph(
    parent: ParentAgent,
    graph: LiveGraph,
    signal: AbortSignal,
    seed?: ReadonlyMap<string, RunState>,
  ): Promise<DelegateResult> {
    const parentSessionId = parent.session.id
    const existing = graph.members
    /** 把当前成员状态落一份结构化快照（与事件日志并行）。 */
    const snapshot = (): void => {
      withStore((store) => {
        for (const member of existing) void store.putMember(toPersistedMember(member))
      })
    }

    const publish = (phases: ReadonlyMap<string, RunState>): void => {
      if (graph.callId === '' || graph.turn === undefined) return
      const runs = journalRuns(graph.plan, phases).map((run) => {
        const member = existing.find(item => item.runId === run.runId)
        if (member !== undefined) member.phase = run.phase
        const memberId = run.memberId ?? member?.memberId
        if (memberId !== undefined) {
          const state = graph.states.get(run.runId)
          graph.states.set(run.runId, {
            phase: run.phase,
            memberId,
            ...state?.output === undefined ? {} : { output: state.output },
            ...state?.error === undefined ? {} : { error: state.error },
          })
        } else {
          graph.states.set(run.runId, { phase: run.phase })
        }
        return memberId === undefined ? run : { ...run, memberId }
      })
      appendRunJournal(parent.session, { turn: graph.turn, callId: graph.callId, runs })
      const completed = runs.filter(run => TERMINAL.has(run.phase)).length
      appendCeoRunProgress(parent.session, {
        turn: graph.turn, callId: graph.callId, completed, total: runs.length,
      })
      // 结构化快照：与事件日志并行落一份可直接读取的状态。
      snapshot()
    }

    // 进入执行前先落一次：replan 对成员的改动（重排/换人/注入方向）即刻持久。
    snapshot()
    const scheduler = new WaveScheduler()
    const abortMap = memberAbortMap(parentSessionId)
    const results = await scheduler.run(graph.plan, async (spec, upstream) => {
      const member = existing.find(item => item.runId === spec.runId)
      if (member !== undefined) member.phase = 'running'
      const extra = [
        member?.steer,
      ].filter((item): item is string => typeof item === 'string' && item.trim() !== '').join('\n')
      // Every channel this prompt carries, with its size. The member
      // sees the same list at the end of its prompt so it can reason about gaps.
      const channels: CeoContextChannel[] = []
      const pushChannel = (channel: string, text: string | undefined, truncated = false): void => {
        const chars = text === undefined ? 0 : Array.from(text).length
        if (chars === 0 && truncated === false) return
        channels.push({ channel, chars, truncated })
      }
      pushChannel('task', spec.task)
      if (planOf(parent)?.teamBrief !== undefined) pushChannel('team_brief', planOf(parent)!.teamBrief)
      if (member?.steer !== undefined && member.steer.trim() !== '') pushChannel('steer', member.steer)
      for (const [runId, state] of upstream) {
        const spec2 = graph.specs.get(runId)
        pushChannel(`dependency:${spec2?.role ?? runId}`, state.output, (state.output ?? '').length > 2000)
      }
      const channelsMap = channelsMapOf(parentSessionId)
      channelsMap.set(spec.runId, channels)
      const prompt = wrapMemberPrompt(
        spec.role,
        spec.task,
        upstream,
        graph.specs,
        extra,
        planOf(parent)?.teamBrief,
        channels,
        spec.runId,
        spec.contract === undefined ? undefined : contractBrief(spec.contract),
      )
      let childId = member?.memberId
      // One abort controller per node: halting a member must not cancel siblings.
      const nodeAbort = new AbortController()
      const onGraphAbort = () => { nodeAbort.abort(signal.reason) }
      signal.addEventListener('abort', onGraphAbort, { once: true })
      abortMap.set(spec.runId, nodeAbort)
      try {
      if (childId === undefined) {
        // 半改道：官方 agentTeams 在场时走 spawnTeammate（成员进官方名册，可恢复、
        // 可信箱投递）；官方缺席或派工失败时原样回退 startContinuable。两条路的
        // 成员都是 continuable 子代理，官方成员 id 就是 childId（roster.ts
        // spawnAdmitted 直接把它传给 startContinuable），residency 无需分叉。
        const teams = readAgentTeams(ctx)
        const officialName = officialMemberNameOf(spec.runId)
        let spawned = false
        if (teams !== undefined) {
          try {
            const result = await teams.spawnTeammate(parent, {
              name: officialName,
              description: spec.task.slice(0, 200),
              prompt: [{ type: 'text', text: prompt }],
              context: 'fresh',
              provider: 'spawn',
              signal: nodeAbort.signal,
            })
            const spawnedId = officialMemberIdOf(result)
            if (spawnedId !== undefined) {
              childId = spawnedId
              spawned = true
              if (member !== undefined) {
                trackMemberChild(member, childId)
                member.officialName = officialName
                member.phase = 'running'
              }
            }
          } catch (error) {
            console.warn(`[magic-ceo] official roster spawn failed for ${spec.runId}, falling back to subagents: ${errorMessage(error)}`)
          }
        }
        if (!spawned) {
          const started = await ctx.subagents.startContinuable({
            provider: 'spawn',
            label: spec.role,
            request: {
              prompt: [{ type: 'text', text: prompt }],
              parent,
            },
            signal: nodeAbort.signal,
          })
          childId = started.childId
          if (member !== undefined) {
            trackMemberChild(member, childId)
            member.phase = 'running'
          }
        }
      } else if (member?.officialName !== undefined) {
        // 官方名册成员：续派走持久信箱（按名路由，离线排队）；信箱不可用或
        // 投递被拒时回退 subagents 直投（成员 id 即 childId，两条路等价）。
        const teams = readAgentTeams(ctx)
        let delivered = false
        if (teams !== undefined) {
          try {
            await teams.sendMessage(parent, {
              target: member.officialName,
              content: [{ type: 'text', text: prompt }],
              signal: nodeAbort.signal,
            })
            delivered = true
          } catch (error) {
            console.warn(`[magic-ceo] official mailbox steer failed for ${spec.runId}, falling back to subagents: ${errorMessage(error)}`)
          }
        }
        if (!delivered) {
          await ctx.subagents.sendMessage(
            parent,
            childId,
            [{ type: 'text', text: prompt }],
            { signal: nodeAbort.signal },
          )
        }
        if (member !== undefined) member.phase = 'running'
      } else {
        await ctx.subagents.sendMessage(
          parent,
          childId,
          [{ type: 'text', text: prompt }],
          { signal: nodeAbort.signal },
        )
        if (member !== undefined) member.phase = 'running'
      }
      const live = new Map<string, RunState>()
      for (const node of graph.plan.nodes) {
        const item = existing.find(entry => entry.runId === node.runId)
        const seeded = graph.states.get(node.runId)
        live.set(node.runId, {
          phase: item?.phase ?? seeded?.phase ?? 'queued',
          ...item?.memberId === undefined ? {} : { memberId: item.memberId },
          ...seeded?.output === undefined ? {} : { output: seeded.output },
        })
      }
      // spawn/续派两条路结束后 childId 必已赋值；此处缺失属异常，宁可显式失败
      // 也不能把 undefined 当 memberId 写进镜像与账本。
      if (childId === undefined) throw new Error('ceo_delegate: member 子会话未启动')
      publish(live)
      attachRunProcessMirror({
        parent: parent.session,
        turn: graph.turn,
        callId: graph.callId,
        runId: spec.runId,
        memberId: childId,
        childSessionId: childId,
      })
      const afterSeq = member?.turnSeq ?? -1
      const result = await waitForChildTurn(childId, nodeAbort.signal, afterSeq)
      if (member !== undefined) member.turnSeq = result.seq
      if (graph.turn !== undefined && graph.callId !== '') {
        appendCeoRunPhase(parent.session, {
          turn: graph.turn, callId: graph.callId, runId: spec.runId, memberId: childId, phase: 'winding_down',
        })
      }
      const selfReport = classifyWorkerDelivery(spec, result.output, result.stopReason)
      // 物证复核：账本说"没达标"时推翻自述。只可能把"自述达标"打成不达标，不会把失败改好。
      const evidence = evidenceVerdictOf(readLedger(ctx), spec)
      const delivery = evidence === undefined
        ? selfReport
        : applyEvidenceVerdict(selfReport, evidence.verdict, evidence.landedPathsChecked)
      if (delivery.status === 'unverified' && selfReport.status === 'completed') {
        appendCeoCheckpoint(parent.session, {
          turn: graph.turn, callId: graph.callId, kind: 'decision',
          runId: spec.runId, memberId: childId,
          note: `delivery contract not satisfied by evidence: ${delivery.error ?? 'unknown'}`,
        })
      }
      // A user halt must read as cancelled, not as worker failure.
      const state: RunState = isRunHalted(spec.runId) && result.stopReason !== 'completed'
        ? { phase: 'cancelled', memberId: childId, output: result.output, error: 'stopped by user' }
        : {
          phase: delivery.phase,
          memberId: childId,
          output: result.output,
          ...delivery.error === undefined ? {} : { error: delivery.error },
        }
      // Publish cumulative token usage for this member.
      const usage = usageMapOf(parentSessionId).get(spec.runId)
      if (usage !== undefined && graph.turn !== undefined && graph.callId !== '') {
        appendCeoMemberUsage(parent.session, {
          turn: graph.turn, callId: graph.callId, runId: spec.runId, memberId: childId, usage,
        })
        withStore((store) => { void store.addUsage(parentSessionId, spec.runId, { ...usage }) })
      }
      // Persist the channels this prompt carried so the UI can show what the member was fed.
      const nodeChannels = channelsMapOf(parentSessionId).get(spec.runId)
      if (nodeChannels !== undefined && nodeChannels.length > 0 && graph.turn !== undefined && graph.callId !== '') {
        appendCeoMemberContext(parent.session, {
          turn: graph.turn, callId: graph.callId, runId: spec.runId, memberId: childId, channels: nodeChannels,
        })
        withStore((store) => { void store.putChannels(parentSessionId, spec.runId, nodeChannels) })
      }
      if (graph.turn !== undefined && graph.callId !== '') {
        appendCeoMemberResult(parent.session, {
          turn: graph.turn,
          callId: graph.callId,
          runId: spec.runId,
          memberId: childId,
          output: result.output,
          stopReason: result.stopReason,
          status: state.phase === 'cancelled' ? 'unverified' : delivery.status,
        })
      }
      if (state.phase === 'cancelled') {
        appendCeoCheckpoint(parent.session, {
          turn: graph.turn, callId: graph.callId, kind: 'decision',
          runId: spec.runId, memberId: childId,
          note: 'member was halted by the user; replace or add to continue this work',
        })
      }
      if (member !== undefined) {
        member.memberId = childId
        member.phase = state.phase
      }
      graph.states.set(spec.runId, state)
      return state
      } finally {
        signal.removeEventListener('abort', onGraphAbort)
        abortMap.delete(spec.runId)
      }
    }, signal, publish, seed)

    for (const [runId, state] of results) graph.states.set(runId, state)
    graphsByParent.set(parentSessionId, graph)
    return {
      runs: graph.plan.nodes.map(node => {
        const state = results.get(node.runId) ?? graph.states.get(node.runId)
        const member = existing.find(item => item.runId === node.runId)
        const phase = state?.phase ?? member?.phase ?? 'queued'
        if (member !== undefined) member.phase = phase
        const memberId = state?.memberId ?? member?.memberId
        // 工具回执走 DSH 无损 JSON 门（snapshotJsonValue）：undefined 属性会让整份
        // 回执被拒（"value is not lossless JSON"），图跑完却在序列化时炸——2026-09-14
        // 汇总节点未启动时 memberId 为空触发过。未定成员直接省略该键。
        return {
          runId: node.runId,
          role: node.role,
          task: node.task,
          ...(memberId === undefined ? {} : { memberId }),
          phase,
        }
      }),
      ...scheduler.yielded === undefined ? {} : { yielded: scheduler.yielded },
    }
  }

  ctx.tools.register({
    name: 'ceo_plan',
    description:
      'Record the CEO analysis and a proposed run graph before complex delegation. '
      + 'Call this after thinking through scope, evidence, acceptance, roles, and dependencies; '
      + 'then call ceo_delegate with the same tasks array.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: 'The user goal and the planned delivery boundary.' },
        analysis: { type: 'string', description: 'Visible reasoning: scope, unknowns, research angles, and why this split is appropriate.' },
        team_brief: { type: 'string', description: 'Shared context and evidence rules for every worker.' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', description: 'Unique Chinese seat name for this work package, such as 国内市场 or 海外市场. Do not reuse generic labels like 调研 or 汇总.' },
              task: { type: 'string' },
              id: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' } },
              bind_after_deps: { type: 'boolean' },
            },
            required: ['role', 'task'],
          },
        },
      },
      required: ['summary', 'analysis', 'tasks'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string' }, status: { type: 'string' } },
        required: ['planId', 'status'],
      },
      render: (_args, value) => [{ type: 'text', text: `CEO plan ${value.planId ?? 'unknown'} ${value.status ?? 'ready'}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('ceo_plan requires a calling agent')
      const parentSessionId = parent.session.id
      if (ctx.magicWorkMode.getMode(parentSessionId, parent.session) !== 'ceo') {
        throw new Error('ceo_plan requires CEO work mode. Use /mode ceo first.')
      }
      const raw = args as Record<string, unknown>
      const tasks = parseDelegateTasks({ tasks: raw.tasks })
      const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
      const analysis = typeof raw.analysis === 'string' ? raw.analysis.trim() : ''
      if (!summary || !analysis) throw new Error('ceo_plan requires non-empty summary and analysis')
      const turn = currentTurn(parent.session)
      if (turn === undefined) throw new Error('ceo_plan requires an open turn')
      const previous = planOf(parent)
      const plan: CeoPlanData = {
        turn,
        planId: `plan_${String(Date.now())}`,
        version: previous?.turn === turn ? previous.version + 1 : 1,
        summary,
        analysis,
        ...typeof raw.team_brief === 'string' && raw.team_brief.trim() !== ''
          ? { teamBrief: raw.team_brief.trim().slice(0, 1500) }
          : {},
        tasks: tasks.map(task => ({
          ...task.id === undefined ? {} : { id: task.id },
          role: task.role,
          task: task.task,
          dependsOn: task.dependsOn,
          ...task.bindAfterDeps === true ? { bindAfterDeps: true } : {},
        })),
      }
      plansByParent.set(parentSessionId, plan)
      if (previous?.turn === turn) appendCeoPlanRevision(parent.session, plan)
      else appendCeoPlan(parent.session, plan)
      withStore((store) => { void store.putPlan(parentSessionId, toPersistedPlan(plan)) })
      return { planId: plan.planId, status: 'ready' }
    },
  })

  ctx.tools.register({
    name: 'ceo_delegate',
    description:
      'Delegate a CEO run graph. Default path is tasks[]: role + task, optional id, depends_on, and bind_after_deps. '
      + 'Independent tasks run together. A dependent task starts only after its depends_on nodes finish. '
      + 'The graph yields when a member needs a user decision or a bind_after_deps node is ready. '
      + 'Use ceo_replan to resume that same graph. Use only in CEO mode.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tasks: {
          type: 'array',
          description: 'Run graph. Each item is one worker node. Mutually independent nodes run in parallel.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: {
                type: 'string',
                description: 'Unique Chinese seat name for this work package, such as 国内市场 or 海外市场. Do not reuse generic labels like 调研 or 汇总.',
              },
              task: {
                type: 'string',
                description: 'Self-contained task: goal, boundary, and acceptance. The worker does not see this conversation.',
              },
              id: {
                type: 'string',
                description: 'Optional node id. depends_on may reference this literal or the role name.',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'Producer → consumer. Use this batch\'s id or role. Independent tasks omit this.',
              },
              bind_after_deps: {
                type: 'boolean',
                description: 'If true, this node waits after its producers finish until ceo_replan binds it.',
              },
              contract: {
                type: 'object',
                description: 'Optional delivery contract the ledger verifies this node against: '
                  + '{ required_sections: string[], artifacts: string[], citation_mode: "two_phase"|"", form: "prose"|"files", strict: boolean }. '
                  + 'Declare it to hold this node to named sections/artifacts: a "completed" claim is then accepted only if structured '
                  + 'evidence satisfies it, and the worker is told the exact requirements. Omit it to leave acceptance unenforced — '
                  + 'the worker is still asked to file evidence via ledger_record_evidence.',
                additionalProperties: true,
              },
            },
            required: ['role', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
    output: {
      schema: runOutputSchema(),
      render: (_args, value) => renderRuns(value),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('ceo_delegate requires a calling agent')
      }

      const parentSessionId = parent.session.id
      if (ctx.magicWorkMode.getMode(parentSessionId, parent.session) !== 'ceo') {
        throw new Error('ceo_delegate requires CEO work mode. Use /mode ceo first.')
      }

      const live = graphsByParent.get(parentSessionId)
      if (live !== undefined && live.plan.nodes.some(node => {
        const phase = live.states.get(node.runId)?.phase ?? 'queued'
        return phase === 'queued' || phase === 'running' || phase === 'blocked'
      })) {
        throw new Error('A CEO graph is already open. Use ceo_replan to bind, continue, replace, add, or stop it.')
      }

      const tasks = parseDelegateTasks(args)
      const existingPlan = planOf(parent)
      const needsPlan = tasks.some(task => isComplexTask(task, tasks.length))
      if (needsPlan) {
        if (existingPlan === undefined) {
          throw new Error('Complex CEO work requires ceo_plan first: think through scope, evidence, acceptance, and the worker graph before delegating.')
        }
        const plannedTasks = existingPlan.tasks.map(task => ({
          role: task.role, task: task.task, dependsOn: task.dependsOn, bindAfterDeps: task.bindAfterDeps,
        }))
        const currentTasks = tasks.map(task => ({
          role: task.role, task: task.task, dependsOn: task.dependsOn, bindAfterDeps: task.bindAfterDeps,
        }))
        if (taskFingerprint(plannedTasks) !== taskFingerprint(currentTasks)) {
          throw new Error('ceo_delegate tasks do not match the latest CEO plan. Re-run ceo_plan after revising the graph.')
        }
      }
      const prefix = `del_${String(Date.now())}`
      const activeLedger = readLedger(ctx)
      const plan = buildRunPlan(withDefaultContract(tasks, activeLedger), prefix)
      // 契约先进账本：验收时按 runId 查回，不占用 CEO 自己的计划/日志结构。
      registerContracts(activeLedger, plan.nodes)
      const specs = new Map(plan.nodes.map(node => [node.runId, node]))
      const existing = membersOf(parentSessionId)
      const createdAt = new Date().toISOString()
      for (const node of plan.nodes) {
        existing.push({
          runId: node.runId,
          rawId: node.rawId,
          parentSessionId,
          role: node.role,
          task: node.task,
          dependsOn: node.dependsOn,
          phase: 'queued',
          createdAt,
          ...node.bindAfterDeps === true ? { bindAfterDeps: true } : {},
        })
      }

      const callId = typeof exec.callId === 'string' ? exec.callId : ''
      const turn = currentTurn(parent.session)
      if (turn === undefined) throw new Error('ceo_delegate requires an open turn')
      const graph: LiveGraph = {
        plan,
        specs,
        states: new Map(),
        members: existing,
        callId,
        turn,
        prefix,
      }
      graphsByParent.set(parentSessionId, graph)
      const empty = new Map<string, RunState>()
      const publishQueued = (): void => {
        appendRunJournal(parent.session, { turn, callId, runs: journalRuns(plan, empty) })
        appendCeoRunProgress(parent.session, { turn, callId, completed: 0, total: plan.nodes.length })
      }
      publishQueued()
      return driveGraph(parent, graph, exec.signal)
    },
  })

  ctx.tools.register({
    name: 'ceo_replan',
    description:
      'Resume a yielded CEO graph. binds finalizes bind_after_deps nodes. steers adds notes to queued nodes. '
      + 'add appends new nodes. continue forwards a user answer to a blocked living member. '
      + 'replace starts a new member on a failed or unverified seat. stop skips the remaining tail. '
      + 'halt aborts one RUNNING member now (its node reads cancelled; use replace or add to continue the work). '
      + 'redirect stops one running member and queues a fresh steering note for its replacement.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        binds: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              run_id: { type: 'string' },
              role: { type: 'string' },
              task: { type: 'string' },
            },
            required: ['run_id'],
          },
        },
        steers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              run_id: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['run_id', 'note'],
          },
        },
        add: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              role: { type: 'string' },
              task: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' } },
              bind_after_deps: { type: 'boolean' },
              contract: {
                type: 'object',
                description: 'Optional delivery contract verified against structured evidence '
                  + '(required_sections / artifacts / citation_mode / form / strict). '
                  + 'Omit it to leave acceptance unenforced; the worker is still asked to file evidence.',
                additionalProperties: true,
              },
            },
            required: ['role', 'task'],
          },
        },
        continue: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              run_id: { type: 'string' },
              answer: { type: 'string' },
            },
            required: ['run_id', 'answer'],
          },
        },
        replace: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              run_id: { type: 'string' },
              role: { type: 'string' },
              task: { type: 'string' },
            },
            required: ['run_id'],
          },
        },
        halt: {
          type: 'array',
          description: 'Abort one running member now. The node reads cancelled; downstream nodes skip.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              run_id: { type: 'string' },
            },
            required: ['run_id'],
          },
        },
        redirect: {
          type: 'array',
          description: 'Halt the running member, then queue a steering note so ceo_replan add/replace carries the new direction.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              run_id: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['run_id', 'note'],
          },
        },
        resume: {
          type: 'array',
          description: 'Redispatch an unknown_after_restart node from scratch after a restart.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              run_id: { type: 'string' },
            },
            required: ['run_id'],
          },
        },
        stop: { type: 'boolean' },
      },
    },
    output: {
      schema: runOutputSchema(),
      render: (_args, value) => renderRuns(value),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('ceo_replan requires a calling agent')
      const parentSessionId = parent.session.id
      if (ctx.magicWorkMode.getMode(parentSessionId, parent.session) !== 'ceo') {
        throw new Error('ceo_replan requires CEO work mode. Use /mode ceo first.')
      }
      const graph = restoreGraph(parent)
      if (graph === undefined) {
        throw new Error('ceo_replan requires an open CEO graph. Call ceo_delegate first.')
      }
      const raw = (args ?? {}) as Record<string, unknown>
      const findNode = (token: string): RunSpec | undefined => {
        return graph.plan.byId(token)
          ?? graph.plan.nodes.find(node => node.rawId === token)
          ?? graph.plan.nodes.find(node => node.role === token)
      }

      if (Array.isArray(raw.binds)) {
        for (const item of raw.binds) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { run_id?: unknown; role?: unknown; task?: unknown }
          if (typeof record.run_id !== 'string') continue
          const node = findNode(record.run_id.trim())
          if (node === undefined) throw new Error(`ceo_replan bind unknown run_id: ${record.run_id}`)
          node.bindAfterDeps = false
          if (typeof record.role === 'string' && record.role.trim() !== '') node.role = record.role.trim()
          if (typeof record.task === 'string' && record.task.trim() !== '') node.task = record.task.trim()
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member !== undefined) {
            member.bindAfterDeps = false
            member.role = node.role
            member.task = node.task
            if (member.phase === 'queued') member.phase = 'queued'
          }
        }
      }

      if (Array.isArray(raw.steers)) {
        for (const item of raw.steers) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { run_id?: unknown; note?: unknown }
          if (typeof record.run_id !== 'string' || typeof record.note !== 'string') continue
          const node = findNode(record.run_id.trim())
          if (node === undefined) throw new Error(`ceo_replan steer unknown run_id: ${record.run_id}`)
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member !== undefined) member.steer = record.note.trim()
        }
      }

      // Halt running members now. The wave executor maps the abort to cancelled.
      if (Array.isArray(raw.halt)) {
        for (const item of raw.halt) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { run_id?: unknown }
          if (typeof record.run_id !== 'string') continue
          const node = findNode(record.run_id.trim())
          if (node === undefined) throw new Error(`ceo_replan halt unknown run_id: ${record.run_id}`)
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member?.memberId === undefined) {
            throw new Error(`ceo_replan halt requires a running member for ${record.run_id}`)
          }
          haltRun(node.runId)
          // 官方名册成员按名走官方 interrupt（名册状态机会同步）；失败或非官方
          // 成员回退 subagents 直打断（成员 id 即 childId，两者等价）。
          const teams = readAgentTeams(ctx)
          let halted = false
          if (member.officialName !== undefined && teams?.interrupt !== undefined) {
            try {
              teams.interrupt(parent, member.officialName)
              halted = true
            } catch (error) {
              console.warn(`[magic-ceo] official interrupt failed for ${node.runId}, falling back to subagents: ${errorMessage(error)}`)
            }
          }
          if (!halted) ctx.subagents.interrupt?.(member.memberId, { kind: 'ancestor', agent: parent })
          appendCeoMemberHalted(parent.session, {
            turn: graph.turn, callId: graph.callId, runId: node.runId, memberId: member.memberId, reason: 'user_stop',
          })
        }
      }

      // Halt + steering note: the user wants this member stopped and its work
      // redone with a new direction. Records the note for the follow-up replace.
      if (Array.isArray(raw.redirect)) {
        for (const item of raw.redirect) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { run_id?: unknown; note?: unknown }
          if (typeof record.run_id !== 'string' || typeof record.note !== 'string') continue
          const node = findNode(record.run_id.trim())
          if (node === undefined) throw new Error(`ceo_replan redirect unknown run_id: ${record.run_id}`)
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member?.memberId !== undefined) {
            haltRun(node.runId)
            const teams = readAgentTeams(ctx)
            let halted = false
            if (member.officialName !== undefined && teams?.interrupt !== undefined) {
              try {
                teams.interrupt(parent, member.officialName)
                halted = true
              } catch (error) {
                console.warn(`[magic-ceo] official interrupt failed for ${node.runId}, falling back to subagents: ${errorMessage(error)}`)
              }
            }
            if (!halted) ctx.subagents.interrupt?.(member.memberId, { kind: 'ancestor', agent: parent })
            appendCeoMemberHalted(parent.session, {
              turn: graph.turn, callId: graph.callId, runId: node.runId, memberId: member.memberId, reason: 'user_stop',
            })
          }
          appendCeoMemberRedirected(parent.session, {
            turn: graph.turn, callId: graph.callId, runId: node.runId,
            ...member?.memberId === undefined ? {} : { memberId: member.memberId },
            note: record.note.trim(),
          })
        }
      }

      if (Array.isArray(raw.add) && raw.add.length > 0) {
        const extras = parseDelegateTasks({ tasks: raw.add })
        const activeLedger = readLedger(ctx)
        const added = appendTasksToPlan(graph.plan, withDefaultContract(extras, activeLedger), graph.prefix)
        registerContracts(activeLedger, added)
        const createdAt = new Date().toISOString()
        for (const node of added) {
          graph.specs.set(node.runId, node)
          graph.members.push({
            runId: node.runId,
            rawId: node.rawId,
            parentSessionId,
            role: node.role,
            task: node.task,
            dependsOn: node.dependsOn,
            phase: 'queued',
            createdAt,
            ...node.bindAfterDeps === true ? { bindAfterDeps: true } : {},
          })
        }
      }

      const seed = new Map<string, RunState>()
      for (const node of graph.plan.nodes) {
        const state = graph.states.get(node.runId)
        if (state !== undefined && state.phase !== 'queued' && state.phase !== 'running') {
          seed.set(node.runId, state)
        }
      }

      if (Array.isArray(raw.continue)) {
        for (const item of raw.continue) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { run_id?: unknown; answer?: unknown }
          if (typeof record.run_id !== 'string' || typeof record.answer !== 'string') continue
          const node = findNode(record.run_id.trim())
          if (node === undefined) throw new Error(`ceo_replan continue unknown run_id: ${record.run_id}`)
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member === undefined || member.memberId === undefined) {
            throw new Error(`ceo_replan continue requires a living member for ${record.run_id}`)
          }
          member.steer = `User decision:\n${record.answer.trim()}`
          member.phase = 'queued'
          seed.delete(node.runId)
          graph.states.delete(node.runId)
        }
      }

      if (Array.isArray(raw.replace)) {
        for (const item of raw.replace) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { run_id?: unknown; role?: unknown; task?: unknown }
          if (typeof record.run_id !== 'string') continue
          const node = findNode(record.run_id.trim())
          if (node === undefined) throw new Error(`ceo_replan replace unknown run_id: ${record.run_id}`)
          if (typeof record.role === 'string' && record.role.trim() !== '') node.role = record.role.trim()
          if (typeof record.task === 'string' && record.task.trim() !== '') node.task = record.task.trim()
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member !== undefined) {
            delete member.memberId
            delete member.turnSeq
            member.role = node.role
            member.task = node.task
            member.phase = 'queued'
          }
          seed.delete(node.runId)
          graph.states.delete(node.runId)
        }
      }

      if (raw.stop === true) {
        for (const node of graph.plan.nodes) {
          if (seed.has(node.runId)) continue
          const state: RunState = { phase: 'skipped' }
          seed.set(node.runId, state)
          graph.states.set(node.runId, state)
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member !== undefined) member.phase = 'skipped'
        }
      }

      // Restart recovery: an unknown_after_restart node can be redispatched from
      // scratch (replace semantics) without rewriting its recorded failure.
      if (Array.isArray(raw.resume)) {
        for (const item of raw.resume) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as { run_id?: unknown }
          if (typeof record.run_id !== 'string') continue
          const node = findNode(record.run_id.trim())
          if (node === undefined) throw new Error(`ceo_replan resume unknown run_id: ${record.run_id}`)
          const state = graph.states.get(node.runId)
          if (state === undefined || state.phase !== 'unknown_after_restart') {
            throw new Error(`ceo_replan resume requires an unknown_after_restart node: ${record.run_id}`)
          }
          const member = graph.members.find(entry => entry.runId === node.runId)
          if (member !== undefined) {
            delete member.memberId
            delete member.turnSeq
            member.phase = 'queued'
          }
          seed.delete(node.runId)
          graph.states.delete(node.runId)
          appendCeoCheckpoint(parent.session, {
            turn: graph.turn, callId: graph.callId, kind: 'unknown_after_restart',
            runId: node.runId, ...member?.memberId === undefined ? {} : { memberId: member.memberId },
            note: 'resume requested after restart', resolvedAt: Date.now(),
          })
        }
      }

      graph.turn = currentTurn(parent.session) ?? graph.turn
      return driveGraph(parent, graph, exec.signal, seed)
    },
  })
}

export { RunPlan, RunPlanError } from './plan.ts'
export { WaveScheduler, haltRun, isRunHalted, clearHaltedRuns } from './wave.ts'
export { appendTasksToPlan, buildRunPlan, parseDelegateTasks } from './builder.ts'
export {
  classifyWorkerDelivery,
  contractBrief,
  DEFAULT_DELIVERY_CONTRACT,
  declaredResultStatus,
  declaredUserDecisions,
  hasResearchEvidenceGap,
} from './delivery.ts'
export {
  CEO_MEMBER_RESULT,
  CEO_PLAN,
  CEO_PLAN_REVISED,
  CEO_RUN_JOURNAL,
  CEO_RUN_PHASE,
  CEO_RUN_PROGRESS,
  CEO_RUN_PROCESS,
  appendCeoMemberResult,
  appendCeoPlan,
  appendCeoPlanRevision,
  appendCeoRunPhase,
  appendCeoRunProgress,
  appendRunJournal,
  appendRunProcess,
  currentTurn,
  journalRuns,
  latestCeoPlan,
  latestCeoRunJournal,
  memberResultsOf,
  unknownAfterRestartRuns,
} from './journal.ts'
export {
  attachRunProcessMirror,
  detachRunProcessMirror,
  ingestChildSessionEvent,
} from './process.ts'
export { ingestChildTurnEvent, waitForChildTurn } from './residency.ts'
