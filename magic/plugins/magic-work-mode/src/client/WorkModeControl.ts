import { createElement as h, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { isWorkModeConfirmText } from '../handoff.ts'
import {
  applyClientWorkModeLine,
  getClientWorkMode,
  subscribeClientWorkMode,
  type MagicWorkModeState,
} from './state.ts'

export interface WorkModeControlProps {
  sessionId?: string
  executeMode: (line: string) => Promise<string | null>
  t: (key: string, params?: Record<string, unknown>) => string
  useInput?: (selector: (state: { phase?: string }) => string | undefined) => string | undefined
}

const OPTIONS = [
  { id: 'agent', line: '/mode agent', label: 'menu.agent', hint: 'menu.agentHint' },
  { id: 'once-ceo', line: '/mode once ceo', label: 'menu.onceCeo', hint: 'menu.onceCeoHint' },
  { id: 'session-ceo', line: '/mode ceo', label: 'menu.sessionCeo', hint: 'menu.sessionCeoHint' },
] as const

function activeOption(state: MagicWorkModeState): (typeof OPTIONS)[number]['id'] {
  if (state.inputMode === 'ceo') return 'once-ceo'
  if (state.sessionMode === 'ceo') return 'session-ceo'
  return 'agent'
}

export function WorkModeControl({ sessionId, executeMode, t, useInput }: WorkModeControlProps): ReactNode {
  const state = useSyncExternalStore(
    subscribeClientWorkMode,
    () => (sessionId === undefined ? getClientWorkMode('') : getClientWorkMode(sessionId)),
    () => (sessionId === undefined ? getClientWorkMode('') : getClientWorkMode(sessionId)),
  )
  const phase = useInput?.(input => input.phase)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ line: string; text: string } | null>(null)

  useEffect(() => {
    if (sessionId === undefined || phase !== 'submitting') return
    if (getClientWorkMode(sessionId).inputMode === null) return
    applyClientWorkModeLine(sessionId, '/mode once')
  }, [phase, sessionId])

  if (sessionId === undefined) return null

  const effective = state.inputMode ?? state.sessionMode
  const modeLabel = t(effective === 'ceo' ? 'chip.ceo' : 'chip.agent')
  const scopeLabel = t(state.inputMode !== null ? 'scope.input' : 'scope.session')
  const selected = activeOption(state)

  const run = (line: string): void => {
    setBusy(true)
    setError(null)
    void executeMode(line).then((failure) => {
      setBusy(false)
      if (failure !== null) {
        if (isWorkModeConfirmText(failure)) {
          setPending({ line, text: failure })
          return
        }
        setError(failure)
        return
      }
      setPending(null)
      setOpen(false)
    }, (reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return h('div', {
    'data-magic-work-mode': effective,
    'data-magic-work-mode-scope': state.inputMode !== null ? 'input' : 'session',
    style: { position: 'relative', display: 'flex', alignItems: 'center' },
  },
    h('button', {
      type: 'button',
      'aria-label': t('chip.aria', { mode: modeLabel, scope: scopeLabel }),
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      disabled: busy,
      onClick: () => {
        setPending(null)
        setOpen(value => !value)
      },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 8px',
        border: '0.5px solid var(--dsw-alias-border-l2, #2a2a2a)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-module-platform, #161616)',
        color: 'var(--dsw-alias-label-primary, #f5f5f5)',
        fontSize: 12,
        cursor: busy ? 'default' : 'pointer',
      },
    }, `${modeLabel} · ${scopeLabel}`),
    error === null ? null : h('span', {
      role: 'status',
      title: error,
      style: { marginLeft: 6, fontSize: 11, color: 'var(--dsw-alias-state-danger, #dc2626)' },
    }, t('error')),
    !open ? null : h('div', {
      role: 'menu',
      style: {
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 6px)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: pending === null ? 260 : 320,
        padding: 6,
        border: '0.5px solid var(--dsw-alias-border-l2, #2a2a2a)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-module-platform, #161616)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      },
    },
      pending === null
        ? OPTIONS.map(option => h('button', {
          key: option.id,
          type: 'button',
          role: 'menuitem',
          disabled: busy,
          onClick: () => run(option.line),
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            width: '100%',
            padding: '8px 8px',
            border: option.id === selected
              ? '0.5px solid var(--dsw-alias-label-primary, #f5f5f5)'
              : '0.5px solid transparent',
            borderRadius: 8,
            background: option.id === selected
              ? 'var(--dsw-alias-bg-module, #1f1f1f)'
              : 'transparent',
            color: 'var(--dsw-alias-label-primary, #f5f5f5)',
            textAlign: 'left',
            cursor: busy ? 'default' : 'pointer',
          },
        },
          h('span', { style: { fontSize: 12, fontWeight: 510 } }, t(option.label)),
          h('span', {
            style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #9a9a9a)' },
          }, t(option.hint)),
        ))
        : [
          h('div', {
            key: 'confirm-title',
            style: { padding: '6px 8px 2px', fontSize: 12, fontWeight: 510, color: 'var(--dsw-alias-label-primary, #f5f5f5)' },
          }, t('confirm.title')),
          h('div', {
            key: 'confirm-body',
            'data-magic-work-mode-confirm': true,
            style: {
              padding: '4px 8px 8px',
              fontSize: 11,
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-secondary, #c8c8c8)',
              whiteSpace: 'pre-wrap',
            },
          }, pending.text),
          h('div', {
            key: 'confirm-actions',
            style: { display: 'flex', gap: 6, padding: '0 4px 4px' },
          },
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => run(`${pending.line} confirm`),
              style: {
                flex: 1,
                height: 28,
                border: 0,
                borderRadius: 8,
                background: 'var(--dsw-alias-label-primary, #f5f5f5)',
                color: 'var(--dsw-alias-bg-base, #111)',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
              },
            }, t('confirm.continue')),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => setPending(null),
              style: {
                flex: 1,
                height: 28,
                border: '0.5px solid var(--dsw-alias-border-l2, #2a2a2a)',
                borderRadius: 8,
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary, #f5f5f5)',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
              },
            }, t('confirm.cancel')),
          ),
        ],
    ),
  )
}
