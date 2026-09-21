import { appendCeoRunPhase, appendRunProcess, type CeoProcessOp, type JournalSession } from './journal.ts'

const FLUSH_MS = 120
const RESULT_LIMIT = 2000
const ARGS_LIMIT = 1200
const SOURCE_LIMIT = 12
const TITLE_LIMIT = 160
const SNIPPET_LIMIT = 240

export interface ChildSessionEvent {
  type?: string
  seq?: number
  data?: unknown
}

export interface ChildJournalSession {
  id?: string
  snapshotEvents?: () => readonly ChildSessionEvent[]
}

interface Mirror {
  parent: JournalSession
  turn: number
  callId: string
  runId: string
  memberId: string
  reasoning: string
  content: string
  flushedReasoning: string
  flushedContent: string
  lastSeq: number
  timer: ReturnType<typeof setTimeout> | undefined
  phase: 'thinking' | 'tool' | 'waiting' | 'winding_down' | undefined
}

const mirrors = new Map<string, Mirror>()

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

/**
 * Write/edit JSON is mostly file content. Clipping the raw string at ARGS_LIMIT
 * yields invalid JSON, so the client cannot read `file_path`. Keep the path
 * (and editor command) when the full arguments do not fit.
 */
function clipToolArgs(raw: string): string {
  if (raw.length <= ARGS_LIMIT) return raw
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = asRecord(JSON.parse(raw))
  } catch {
    parsed = undefined
  }
  if (parsed !== undefined) {
    const compact: Record<string, string> = {}
    if (typeof parsed.file_path === 'string' && parsed.file_path.trim() !== '') {
      compact.file_path = parsed.file_path
    }
    if (typeof parsed.path === 'string' && parsed.path.trim() !== '') {
      compact.path = parsed.path
    }
    if (typeof parsed.command === 'string' && parsed.command.trim() !== '') {
      compact.command = parsed.command
    }
    if (Object.keys(compact).length > 0) return JSON.stringify(compact)
  }
  return clip(raw, ARGS_LIMIT)
}

function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function searchSourcesOf(data: unknown): Array<{ url: string; title?: string; snippet?: string }> {
  const record = asRecord(data)
  const meta = asRecord(record?.meta)
  const raw = Array.isArray(meta?.sources) ? meta.sources : []
  const sources: Array<{ url: string; title?: string; snippet?: string }> = []
  for (const item of raw.slice(0, SOURCE_LIMIT)) {
    const source = asRecord(item)
    if (source === undefined || typeof source.url !== 'string' || source.url.trim() === '') continue
    const title = typeof source.title === 'string' ? clip(source.title, TITLE_LIMIT) : undefined
    const snippet = typeof source.snippet === 'string' ? clip(source.snippet, SNIPPET_LIMIT) : undefined
    sources.push({
      url: source.url,
      ...title === undefined || title === '' ? {} : { title },
      ...snippet === undefined || snippet === '' ? {} : { snippet },
    })
  }
  return sources
}

function toolResultOf(data: unknown): {
  toolCallId: string
  result?: string
  isError: boolean
  sources?: Array<{ url: string; title?: string; snippet?: string }>
} {
  const record = asRecord(data)
  const message = asRecord(record?.message)
  const source = asRecord(message?.source)
  const block = Array.isArray(message?.content) ? asRecord(message.content[0]) : undefined
  const toolCallId = typeof block?.toolCallId === 'string'
    ? block.toolCallId
    : typeof source?.callId === 'string'
      ? source.callId
      : ''
  const isError = block?.isError === true || record?.error !== undefined
  const result = clip(textFromBlocks(block?.content), RESULT_LIMIT)
  const sources = searchSourcesOf(data)
  return {
    toolCallId,
    ...result === '' ? {} : { result },
    isError,
    ...sources.length === 0 ? {} : { sources },
  }
}

function emit(mirror: Mirror, op: CeoProcessOp): void {
  appendRunProcess(mirror.parent, {
    turn: mirror.turn,
    callId: mirror.callId,
    runId: mirror.runId,
    memberId: mirror.memberId,
    op,
  })
}

function emitPhase(mirror: Mirror, phase: Mirror['phase'], toolName?: string): void {
  if (phase === undefined || (mirror.phase === phase && phase !== 'tool')) return
  mirror.phase = phase
  appendCeoRunPhase(mirror.parent, {
    turn: mirror.turn,
    callId: mirror.callId,
    runId: mirror.runId,
    memberId: mirror.memberId,
    phase,
    ...phase === 'tool' && toolName ? { toolName } : {},
  })
}

function startFresh(mirror: Mirror): void {
  mirror.reasoning = ''
  mirror.content = ''
  mirror.flushedReasoning = ''
  mirror.flushedContent = ''
}

function flush(mirror: Mirror): void {
  if (mirror.timer !== undefined) {
    clearTimeout(mirror.timer)
    mirror.timer = undefined
  }
  if (mirror.reasoning !== mirror.flushedReasoning && mirror.reasoning.trim() !== '') {
    emit(mirror, { kind: 'reasoning', text: mirror.reasoning })
    mirror.flushedReasoning = mirror.reasoning
  }
  if (mirror.content !== mirror.flushedContent && mirror.content.trim() !== '') {
    emit(mirror, { kind: 'content', text: mirror.content })
    mirror.flushedContent = mirror.content
  }
}

function schedule(mirror: Mirror): void {
  if (mirror.timer !== undefined) return
  mirror.timer = setTimeout(() => {
    mirror.timer = undefined
    flush(mirror)
  }, FLUSH_MS)
}

function applyChunk(mirror: Mirror, data: unknown): void {
  const chunk = asRecord(asRecord(data)?.chunk)
  if (chunk === undefined) return
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
    emitPhase(mirror, 'thinking')
    mirror.reasoning += chunk.text
    schedule(mirror)
    return
  }
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    emitPhase(mirror, 'winding_down')
    mirror.content += chunk.text
    schedule(mirror)
    return
  }
  if (chunk.type !== 'block-end') return
  const block = asRecord(chunk.block)
  if (block?.type === 'reasoning' && typeof block.text === 'string') {
    mirror.reasoning = block.text
    flush(mirror)
    startFresh(mirror)
    return
  }
  if (block?.type === 'text' && typeof block.text === 'string') {
    mirror.content = block.text
    flush(mirror)
    startFresh(mirror)
  }
}

function applyEvent(mirror: Mirror, event: ChildSessionEvent): void {
  if (event.type === 'assistant/chunk') {
    applyChunk(mirror, event.data)
    return
  }
  if (event.type === 'tool/call') {
    flush(mirror)
    startFresh(mirror)
    const data = asRecord(event.data)
    const toolCallId = typeof data?.callId === 'string' ? data.callId : ''
    const name = typeof data?.name === 'string' ? data.name : 'tool'
    emitPhase(mirror, 'tool', name)
    if (toolCallId === '') return
    const args = typeof data?.arguments === 'string' ? clipToolArgs(data.arguments) : undefined
    emit(mirror, {
      kind: 'tool-start',
      toolCallId,
      name,
      ...args === undefined || args === '' ? {} : { args },
    })
    return
  }
  if (event.type !== 'tool/result') return
  flush(mirror)
  startFresh(mirror)
  const parsed = toolResultOf(event.data)
  if (parsed.toolCallId === '') return
  emit(mirror, {
    kind: 'tool-end',
    toolCallId: parsed.toolCallId,
    ...parsed.result === undefined ? {} : { result: parsed.result },
    ...parsed.sources === undefined ? {} : { sources: parsed.sources },
    ...parsed.isError ? { isError: true } : {},
  })
  emitPhase(mirror, 'thinking')
}

export function resetProcessMirrorsForTests(): void {
  for (const mirror of mirrors.values()) {
    if (mirror.timer !== undefined) clearTimeout(mirror.timer)
  }
  mirrors.clear()
}

export function attachRunProcessMirror(input: {
  parent: JournalSession
  turn: number | undefined
  callId: string
  runId: string
  memberId: string
  childSessionId: string
  child?: ChildJournalSession
}): void {
  if (input.callId === '' || input.turn === undefined) return
  detachRunProcessMirror(input.childSessionId)
  const mirror: Mirror = {
    parent: input.parent,
    turn: input.turn,
    callId: input.callId,
    runId: input.runId,
    memberId: input.memberId,
    reasoning: '',
    content: '',
    flushedReasoning: '',
    flushedContent: '',
    lastSeq: -1,
    timer: undefined,
    phase: undefined,
  }
  mirrors.set(input.childSessionId, mirror)
  emitPhase(mirror, 'thinking')
  for (const event of input.child?.snapshotEvents?.() ?? []) {
    ingestChildSessionEvent(input.childSessionId, event)
  }
}

export function detachRunProcessMirror(childSessionId: string): void {
  const mirror = mirrors.get(childSessionId)
  if (mirror === undefined) return
  flush(mirror)
  mirrors.delete(childSessionId)
}

export function ingestChildSessionEvent(sessionId: string, event: ChildSessionEvent): void {
  const mirror = mirrors.get(sessionId)
  if (mirror === undefined) return
  if (typeof event.seq === 'number') {
    if (event.seq <= mirror.lastSeq) return
    mirror.lastSeq = event.seq
  }
  applyEvent(mirror, event)
}
