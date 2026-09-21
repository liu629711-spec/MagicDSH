import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConsultCatalog, renderConsultDirectory } from '../src/catalog.ts'
import { apply, resetConsultCacheForTests } from '../src/index.ts'

const data = {
  topics: () => [
    { id: 'n1', content: '# 主题笔记：官网\n- 主色深蓝', tags: ['topic', 'topic:官网', 'note'] },
    { id: 'n2', content: '# 主题笔记：预算\n- 上限十万', tags: ['topic', 'topic:预算', 'note'] },
  ],
  rules: (audience: 'ceo' | 'member', onDemandOnly: boolean) => {
    const all = [
      { id: 'r1', content: '部署前必须跑测试', tags: ['rule:deploy', 'always'] },
      { id: 'r2', content: '对外文案用中文', tags: ['rule:copywriting'] },
    ]
    return onDemandOnly ? all.filter((rule) => !rule.tags.includes('always')) : all
  },
}

test('目录：记忆主题 + 按需规则合并，常驻规则不进目录', () => {
  const catalog = buildConsultCatalog(data, 'ceo')
  const names = catalog.entries.map((entry) => entry.name)
  assert.deepEqual(names, ['官网', '预算', 'copywriting'])
  const rendered = renderConsultDirectory(catalog)
  assert.match(rendered, /<按需目录>/)
  assert.match(rendered, /官网/)
  assert.match(rendered, /copywriting/)
  assert.doesNotMatch(rendered, /deploy/) // always 规则走常驻注入，不进目录
})

test('fetchByName：按名取正文；缺失时 undefined', () => {
  const catalog = buildConsultCatalog(data, 'ceo')
  assert.match(catalog.fetchByName('官网') ?? '', /深蓝/)
  assert.equal(catalog.fetchByName('不存在'), undefined)
})

test('consult 工具：取文、软缺失列出可选名、缓存复用', async () => {
  resetConsultCacheForTests()
  const registered: Record<string, { execute: (args: unknown, context?: unknown) => unknown }> = {}
  const sections: Array<{ name: string; text: string | ((context?: { agent?: { session?: { id?: string } } }) => string) }> = []
  const ctx = {
    tools: { register: (tool: { name: string; execute: (args: unknown, context?: unknown) => unknown }) => { registered[tool.name] = tool } },
    systemPrompt: { section: (section: { name: string; text: string | ((context?: { agent?: { session?: { id?: string } } }) => string) }) => { sections.push(section) } },
    magicMemory: data,
    magicWorkMode: { getMode: () => 'ceo' as const },
  }
  await apply(ctx)

  const consult = registered['consult']
  assert.ok(consult !== undefined)
  assert.equal(consult.execute({ name: '预算' }), '# 主题笔记：预算\n- 上限十万')
  // 软缺失：不抛错（success 语义）+ 可选名列表
  const miss = consult.execute({ name: '不存在' }) as string
  assert.match(miss, /没有名为 '不存在' 的条目/)
  assert.match(miss, /官网/)
  // 缓存复用
  assert.match(consult.execute({ name: '预算' }) as string, /复用缓存/)
  // 空 name：列出可查阅
  assert.match(consult.execute({}) as string, /可查阅/)

  // 系统提示词「按需目录」段已注册
  assert.ok(sections.some((section) => section.name === 'magic-consult-directory'))
})

test('magic-memory 缺席：目录为空，不崩', async () => {
  resetConsultCacheForTests()
  const registered: Record<string, { execute: (args: unknown) => unknown }> = {}
  await apply({
    tools: { register: (tool: { name: string; execute: (args: unknown) => unknown }) => { registered[tool.name] = tool } },
    systemPrompt: { section: () => undefined },
  })
  const out = registered['consult']!.execute({ name: '任意' }) as string
  assert.match(out, /按需目录为空/)
})
