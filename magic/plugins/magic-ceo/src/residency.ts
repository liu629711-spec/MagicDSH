export interface ChildTurnResult {
  output: string
  stopReason: string
  seq: number
}

interface ChildFold {
  message: string
  partial: string
  lastSeq: number
  lastEnd?: { seq: number; output: string; stopReason: string }
}

interface Waiter {
  afterSeq: number
  resolve: (result: ChildTurnResult) => void
  reject: (error: unknown) => void
}

const folds = new Map<string, ChildFold>()
const waiters = new Map<string, Waiter[]>()

function foldOf(childId: string): ChildFold {
  const existing = folds.get(childId)
  if (existing !== undefined) return existing
  const created: ChildFold = { message: '', partial: '', lastSeq: -1 }
  folds.set(childId, created)
  return created
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function stopReasonOf(data: unknown): string {
  const reason = asRecord(asRecord(data)?.reason)
  if (typeof reason?.kind === 'string' && reason.kind.trim() !== '') return reason.kind.trim()
  if (typeof data === 'object' && data !== null && 'kind' in data) {
    const kind = (data as { kind?: unknown }).kind
    if (typeof kind === 'string' && kind.trim() !== '') return kind.trim()
  }
  return 'completed'
}

function settle(childId: string, end: { seq: number; output: string; stopReason: string }): void {
  const pending = waiters.get(childId)
  if (pending === undefined || pending.length === 0) return
  const next: Waiter[] = []
  for (const waiter of pending) {
    if (end.seq > waiter.afterSeq) {
      waiter.resolve({ output: end.output, stopReason: end.stopReason, seq: end.seq })
    }
    else next.push(waiter)
  }
  if (next.length === 0) waiters.delete(childId)
  else waiters.set(childId, next)
}

export function resetResidencyForTests(): void {
  folds.clear()
  waiters.clear()
}

export function ingestChildTurnEvent(sessionId: string, event: { type?: string; seq?: number; data?: unknown }): void {
  const fold = foldOf(sessionId)
  if (typeof event.seq === 'number') {
    if (event.seq <= fold.lastSeq && event.type !== 'turn/end') return
    if (event.seq > fold.lastSeq) fold.lastSeq = event.seq
  }
  if (event.type === 'assistant/message') {
    const message = asRecord(asRecord(event.data)?.message)
    const text = textFromContent(message?.content)
    if (text.trim() !== '') {
      fold.message = text
      fold.partial = ''
    }
    return
  }
  if (event.type === 'assistant/chunk') {
    const chunk = asRecord(asRecord(event.data)?.chunk)
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
      fold.partial += chunk.text
    }
    return
  }
  if (event.type !== 'turn/end') return
  const output = fold.message.trim() !== '' ? fold.message : fold.partial
  const end = {
    seq: typeof event.seq === 'number' ? event.seq : fold.lastSeq + 1,
    output,
    stopReason: stopReasonOf(event.data),
  }
  fold.lastEnd = end
  fold.message = ''
  fold.partial = ''
  settle(sessionId, end)
}

export function waitForChildTurn(
  childId: string,
  signal?: AbortSignal,
  afterSeq = -1,
): Promise<ChildTurnResult> {
  const fold = foldOf(childId)
  if (fold.lastEnd !== undefined && fold.lastEnd.seq > afterSeq) {
    return Promise.resolve({
      output: fold.lastEnd.output,
      stopReason: fold.lastEnd.stopReason,
      seq: fold.lastEnd.seq,
    })
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ceo member wait aborted'))
      return
    }
    const onAbort = () => {
      const pending = waiters.get(childId) ?? []
      waiters.set(childId, pending.filter(item => item !== waiter))
      reject(new Error('ceo member wait aborted'))
    }
    const waiter: Waiter = {
      afterSeq,
      resolve: (result) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const pending = waiters.get(childId) ?? []
    pending.push(waiter)
    waiters.set(childId, pending)
  })
}
