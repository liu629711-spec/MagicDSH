import { createElement as h, type ReactNode } from 'react'
import type { WorkModeChangedData } from '../persist.ts'

export interface WorkModeChangedCardProps {
  node: { data: WorkModeChangedData }
  t: (key: string, params?: Record<string, unknown>) => string
}

function modeLabel(mode: string, t: WorkModeChangedCardProps['t']): string {
  return t(mode === 'ceo' ? 'chip.ceo' : 'chip.agent')
}

export function WorkModeChangedCard({ node, t }: WorkModeChangedCardProps): ReactNode {
  const data = node.data
  return h('section', {
    'data-magic-work-mode-changed': true,
    style: {
      padding: '10px 12px',
      borderRadius: 10,
      border: '0.5px solid var(--dsw-alias-border-l2, #2a2a2a)',
      background: 'var(--dsw-alias-bg-module-platform, #161616)',
      color: 'var(--dsw-alias-label-primary, #f5f5f5)',
    },
  },
    h('strong', { style: { display: 'block', fontSize: 13, marginBottom: 4 } }, t('changed.title')),
    h('div', {
      style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #c8c8c8)' },
    }, t('changed.fromTo', { from: modeLabel(data.from, t), to: modeLabel(data.to, t) })),
    data.summary === undefined
      ? null
      : h('div', {
        style: { marginTop: 6, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #c8c8c8)' },
      }, data.summary),
    data.members.length === 0
      ? null
      : h('ul', {
        style: { margin: '6px 0 0', paddingLeft: 16, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #9a9a9a)' },
      }, ...data.members.map(member => h('li', {
        key: `${member.role}-${member.phase}`,
      }, `${member.role} [${member.phase}]`))),
  )
}
