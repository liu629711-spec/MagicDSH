import { WorkModeChangedCard } from './WorkModeChangedCard.ts'
import { WorkModeControl } from './WorkModeControl.ts'
import { inject, registerWorkModeUi } from './register.ts'

export { inject }

export function apply(ctx: Parameters<typeof registerWorkModeUi>[0]) {
  registerWorkModeUi(ctx, { chip: WorkModeControl, changed: WorkModeChangedCard })
}
