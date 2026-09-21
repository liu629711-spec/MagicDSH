status: 一页索引
date: 2026-09-21

# Magic —— 仓库与文档索引

**产品一句话**：在开源 DSH 底座上做我们自己的 agent 产品。

## 目录归属

```
magic/
├─ AGENTS.md          我们的项目规则（每次会话该被提醒的规矩）
├─ plugins/           我们的插件（@magic/* scope）
├─ patches/           挂载清单
│  ├─ magic.patch.yml         官方能力开关 + 已迁入 fork 的产品插件
│  └─ legacy-vendored.patch.yml  按路径引用老仓：第三方 vendored 与 ceo-ui（长期状态，非待清理）
├─ scripts/
│  └─ start-web.mjs   一条命令起 Magic 实例（web 面）
└─ docs/
   ├─ README.md       本文件
   ├─ 底座边界.md      我们改了底座哪几处 · 禁改清单 · 构建怎么生效
   ├─ 决策记录.md      裁定时间线（含待裁定）
   ├─ 产品/           PRD：产品语义唯一真源（**重写**，不从老仓搬）
   ├─ 对标-3099基线.md  3099 能力清单 × 底座有无官方对应 × 结论
   └─ 00-仓库与文档收口方案.md  本次收口的方案原件（待签字）
```

上游区（`packages/` `apps/` `vendor/` …）是**读源码**的对象，不复制描述、不影子实现。

## 去哪找答案

| 你要问的 | 去这里 |
| --- | --- |
| 这个产品该做成什么样、为什么 | `docs/产品/` 对应 PRD |
| 我能不能改这个文件、改完要登记吗 | `docs/底座边界.md` |
| 这件事以前裁过没有 | `docs/决策记录.md` |
| 某能力要不要自己做还是用官方 | `docs/对标-3099基线.md` |
| 底座某能力到底怎么实现的 | 读 `packages/*/*` 源码 + 上游 `docs/` |
| 怎么把实例跑起来 | `magic/scripts/start-web.mjs` 头部注释 |

## 现在做到哪（一句话，详情在 `决策记录.md` 与 fork 的 git log）

fork `magic/main` 上：7 个自研插件已迁入并过上游门禁，挂载清单已收进 `magic/patches/`，
web 实例可一条命令起。剩下的结构收口与能力对表见 `00-仓库与文档收口方案.md`。
