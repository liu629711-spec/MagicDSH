import { RunPlan, type RunSpec, type RunState } from './plan.ts'

export type RunExecutor = (
  spec: RunSpec,
  upstream: ReadonlyMap<string, RunState>,
) => Promise<RunState>

export type RunProgress = (
  snapshot: ReadonlyMap<string, RunState>,
) => void | Promise<void>

export type WaveYieldReason = 'decision' | 'bind'

const FAILED = new Set(['failed', 'skipped', 'cancelled', 'unverified', 'unknown_after_restart'])

/** Nodes the user halted mid-run. They must not be re-dispatched by this run(). */
const halted = new Set<string>()

/** Request cancellation of one running node. The executor observes it via the
 *  shared abort signal it was handed; wave() then marks the node cancelled and
 *  downstream dependents are skipped like any other failed dependency. */
export function haltRun(runId: string): void {
  halted.add(runId)
}

export function isRunHalted(runId: string): boolean {
  return halted.has(runId)
}

export function clearHaltedRuns(): void {
  halted.clear()
}

function snapshotOf(
  plan: RunPlan,
  completed: ReadonlyMap<string, RunState>,
  inFlight: ReadonlyMap<string, Promise<void>>,
): Map<string, RunState> {
  const snapshot = new Map<string, RunState>()
  for (const node of plan.nodes) {
    const done = completed.get(node.runId)
    if (done !== undefined) {
      snapshot.set(node.runId, done)
    } else if (inFlight.has(node.runId)) {
      snapshot.set(node.runId, { phase: 'running' })
    } else {
      snapshot.set(node.runId, { phase: 'queued' })
    }
  }
  return snapshot
}

async function emitProgress(
  onProgress: RunProgress | undefined,
  plan: RunPlan,
  completed: ReadonlyMap<string, RunState>,
  inFlight: ReadonlyMap<string, Promise<void>>,
): Promise<void> {
  if (onProgress === undefined) return
  try {
    await onProgress(snapshotOf(plan, completed, inFlight))
  } catch {
    // Progress is observational; a journal failure must not stop the graph.
  }
}

function depsReady(spec: RunSpec, completed: ReadonlyMap<string, RunState>): boolean {
  return spec.dependsOn.every(dep => {
    const state = completed.get(dep)
    return state !== undefined && state.phase !== 'blocked'
  })
}

function shouldSkip(spec: RunSpec, completed: ReadonlyMap<string, RunState>): boolean {
  return spec.dependsOn.some(dep => {
    const state = completed.get(dep)
    return state !== undefined && FAILED.has(state.phase)
  })
}

function bindPending(
  plan: RunPlan,
  completed: ReadonlyMap<string, RunState>,
  inFlight: ReadonlyMap<string, Promise<void>>,
): RunSpec[] {
  return plan.nodes.filter(node =>
    node.bindAfterDeps === true
    && !completed.has(node.runId)
    && !inFlight.has(node.runId)
    && depsReady(node, completed)
    && !shouldSkip(node, completed),
  )
}

function yieldReasonOf(
  plan: RunPlan,
  completed: ReadonlyMap<string, RunState>,
  inFlight: ReadonlyMap<string, Promise<void>>,
): WaveYieldReason | undefined {
  if (inFlight.size > 0) return undefined
  if ([...completed.values()].some(state => state.phase === 'blocked')) return 'decision'
  if (bindPending(plan, completed, inFlight).length > 0) return 'bind'
  return undefined
}

export class WaveScheduler {
  yielded: WaveYieldReason | undefined

  async run(
    plan: RunPlan,
    executor: RunExecutor,
    signal?: AbortSignal,
    onProgress?: RunProgress,
    seed?: ReadonlyMap<string, RunState>,
  ): Promise<Map<string, RunState>> {
    plan.waves()
    this.yielded = undefined
    const completed = new Map<string, RunState>(seed)
    const inFlight = new Map<string, Promise<void>>()

    const dispatch = (): void => {
      if (signal?.aborted) return
      let progressed = true
      while (progressed) {
        progressed = false
        for (const node of plan.nodes) {
          if (completed.has(node.runId) || inFlight.has(node.runId)) continue
          if (!depsReady(node, completed)) continue
          if (shouldSkip(node, completed)) {
            completed.set(node.runId, { phase: 'skipped' })
            progressed = true
            continue
          }
          if (node.bindAfterDeps === true) continue
          const upstream = new Map(
            node.dependsOn.flatMap(dep => {
              const state = completed.get(dep)
              return state === undefined ? [] : [[dep, state] as const]
            }),
          )
          inFlight.set(node.runId, executor(node, upstream).then((state) => {
            completed.set(node.runId, state)
          }, (error: unknown) => {
            // A user halt surfaces as an executor abort; record it as cancelled
            // so dependents skip and the node is honestly not-success.
            completed.set(node.runId, isRunHalted(node.runId)
              ? { phase: 'cancelled', error: 'stopped by user' }
              : {
                phase: 'failed',
                error: error instanceof Error ? error.message : String(error),
              })
          }).finally(() => {
            inFlight.delete(node.runId)
          }))
          progressed = true
        }
      }
    }

    dispatch()
    await emitProgress(onProgress, plan, completed, inFlight)
    while (inFlight.size > 0) {
      await Promise.race(inFlight.values())
      dispatch()
      await emitProgress(onProgress, plan, completed, inFlight)
      const reason = yieldReasonOf(plan, completed, inFlight)
      if (reason !== undefined) {
        this.yielded = reason
        await emitProgress(onProgress, plan, completed, inFlight)
        return completed
      }
    }
    dispatch()
    await emitProgress(onProgress, plan, completed, inFlight)
    this.yielded = yieldReasonOf(plan, completed, inFlight)
    return completed
  }
}
