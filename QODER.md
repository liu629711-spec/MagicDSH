<!-- Magic fork delta: 本文件是 fork 新增的入口路标，上游无此文件；只指路，不放规则正文。
     回退：删除本文件，并撤 `magic/docs/底座边界.md` §1 登记表第 6 行。 -->

# 代理入口

这是 DSH 0.1.6 的 fork（分支 `magic/main`），我们在它上面做自己的 agent 产品 **Magic**。

1. 产品规则的真源是 [`magic/AGENTS.md`](magic/AGENTS.md)，先读它再动手。本文件不复制它的条文。
2. 根 [`AGENTS.md`](AGENTS.md) 是上游写给 harness 贡献者的，**不作为我们的规则**；但动 `packages/`
   上游区时它仍然适用——构建、类型、文风的门禁都写在里面。
3. `D:\Harmess\Magic` 是迁移前的老仓，已停用为只读参考：不在里面改代码与文档。它目前只剩两个
   用途——`magic/patches/legacy-vendored.patch.yml` 按路径引用它的包，以及对标时起 3099 参考实例。
4. 现状、裁定、fork 改动清单进 `magic/docs/`，别往本文件加。
