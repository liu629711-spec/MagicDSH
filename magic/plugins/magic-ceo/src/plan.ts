export type RunPhase =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'unverified'
  | 'unknown_after_restart'
  | 'blocked'

export interface RunSpec {
  runId: string
  rawId: string
  role: string
  task: string
  dependsOn: string[]
  bindAfterDeps?: boolean
  /**
   * 可选交付契约（原始形态，由 magic-ledger 归一化）。
   * 携带时该节点的完成判定由物证验收复核；缺省时行为与接入账本前完全一致。
   */
  contract?: unknown
}

export interface RunState {
  phase: RunPhase
  memberId?: string
  output?: string
  error?: string
}

export class RunPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunPlanError'
  }
}

export class RunPlan {
  readonly nodes: RunSpec[] = []

  add(spec: RunSpec): RunSpec {
    if (this.nodes.some(node => node.runId === spec.runId)) {
      throw new RunPlanError(`duplicate run_id: ${spec.runId}`)
    }
    this.nodes.push(spec)
    return spec
  }

  byId(runId: string): RunSpec | undefined {
    return this.nodes.find(node => node.runId === runId)
  }

  waves(): RunSpec[][] {
    const ids = new Set(this.nodes.map(node => node.runId))
    for (const node of this.nodes) {
      for (const dep of node.dependsOn) {
        if (!ids.has(dep)) {
          throw new RunPlanError(`run ${node.runId} depends on unknown run ${dep}`)
        }
      }
    }

    const resolved = new Set<string>()
    const waves: RunSpec[][] = []
    let remaining = this.nodes.slice()
    while (remaining.length > 0) {
      const wave = remaining.filter(node => node.dependsOn.every(dep => resolved.has(dep)))
      if (wave.length === 0) {
        throw new RunPlanError(`dependency cycle among runs: ${remaining.map(node => node.runId).join(', ')}`)
      }
      waves.push(wave)
      for (const node of wave) resolved.add(node.runId)
      remaining = remaining.filter(node => !resolved.has(node.runId))
    }
    return waves
  }
}
