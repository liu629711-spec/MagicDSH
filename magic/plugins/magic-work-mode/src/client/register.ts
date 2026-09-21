import { workModeChangedDefinition, workModeEventDefinition } from './definition.ts'
import { applyClientWorkModeDescription, applyClientWorkModeLine } from './state.ts'

export const inject = ['slots', 'remote', 'remote.commands', 'locale', 'uiConversation']

export const zh = {
  'chip.agent': '代理',
  'chip.ceo': 'CEO',
  'scope.session': '当前会话',
  'scope.input': '本次输入',
  'chip.aria': '{mode} · {scope}',
  'menu.agent': '代理 · 当前会话',
  'menu.agentHint': '后续输入都用代理，不组织成员',
  'menu.onceCeo': 'CEO · 本次输入',
  'menu.onceCeoHint': '只对这一次发送生效，发完回到会话默认',
  'menu.sessionCeo': 'CEO · 当前会话',
  'menu.sessionCeoHint': '后续输入都用 CEO',
  'error': '工作方式没有改成',
  'confirm.title': '工作方式还没改',
  'confirm.continue': '继续改',
  'confirm.cancel': '先不改',
  'changed.title': '工作方式已改变',
  'changed.fromTo': '{from} → {to}',
}

export const en = {
  'chip.agent': 'Agent',
  'chip.ceo': 'CEO',
  'scope.session': 'this session',
  'scope.input': 'this input',
  'chip.aria': '{mode} · {scope}',
  'menu.agent': 'Agent · this session',
  'menu.agentHint': 'Later inputs use agent. No long-lived members.',
  'menu.onceCeo': 'CEO · this input',
  'menu.onceCeoHint': 'Only this send. Then the session default returns.',
  'menu.sessionCeo': 'CEO · this session',
  'menu.sessionCeoHint': 'Later inputs use CEO.',
  'error': 'Work mode did not change',
  'confirm.title': 'Work mode has not changed yet',
  'confirm.continue': 'Continue',
  'confirm.cancel': 'Not now',
  'changed.title': 'Work mode changed',
  'changed.fromTo': '{from} → {to}',
}

export interface WorkModeUiContext {
  uiConversation: { events: { register: (definition: unknown) => unknown } }
  locale: { register: (ns: string, dicts: { zh: typeof zh; en: typeof en }) => () => void }
  remote: {
    commands: {
      execute: (
        sessionId: string,
        line: string,
        images: unknown[],
      ) => Promise<{
        ok: boolean
        error?: { message?: string; code?: string }
        value?: { result?: { kind?: string; text?: string } }
      }>
    }
  }
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (spec: Record<string, unknown>, component: unknown) => unknown
  }
  effect: (factory: () => unknown, label: string) => unknown
  on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown
}

export function registerWorkModeUi(
  ctx: WorkModeUiContext,
  components: { chip: unknown; changed: unknown },
) {
  ctx.uiConversation.events.register(workModeEventDefinition)
  ctx.uiConversation.events.register(workModeChangedDefinition)
  ctx.effect(() => ctx.locale.register('magicWorkMode', { zh, en }), 'magic-work-mode: dictionaries')
  ctx.on?.('command/executed', (sessionId, name, result) => {
    if (name !== 'mode') return
    const payload = result as { kind?: string; text?: string }
    if (payload.kind !== 'success' || typeof payload.text !== 'string') return
    applyClientWorkModeDescription(String(sessionId), payload.text)
  })
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'magic-work-mode',
    order: 0,
    locale: 'magicWorkMode',
    inject: (sessionId: string) => ({
      sessionId,
      executeMode: async (line: string) => {
        const result = await ctx.remote.commands.execute(sessionId, line, [])
        const commandText = result.value?.result?.text
        if (result.value?.result?.kind === 'error') {
          return typeof commandText === 'string' ? commandText : 'command failed'
        }
        if (!result.ok) {
          return typeof commandText === 'string'
            ? commandText
            : `${result.error?.message ?? 'command failed'} (${result.error?.code ?? 'error'})`
        }
        if (result.value === undefined) return `unknown command: ${line}`
        const text = result.value.result?.text
        if (typeof text === 'string') applyClientWorkModeDescription(sessionId, text)
        else applyClientWorkModeLine(sessionId, line)
        return null
      },
    }),
  }, components.chip))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'magic-work-mode-changed',
    locale: 'magicWorkMode',
  }, components.changed))
}
