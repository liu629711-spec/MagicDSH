import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// host 半（lib/index.js）仍由 root tsdown 的 Host pass 出，所以这里走 hostPhase：
// Host pass 只跑 Node 件，Client pass 才跑浏览器件 —— 与 root 配置里"产品插件只进
// Host pass"的分工一致。
export default clientBundle('@magic/dsh-work-mode', ['lib/types/index.js'], { hostPhase: true })
