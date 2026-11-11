// 运行：pnpm build && node examples/entities.mjs
// 三种独立内容经过相同的 View／资源／调用；不调用模型，不保存到磁盘。
import assert from 'node:assert/strict';
import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { View, createViewSource, openView } from '@weiliang0121/capix-view';
import { Plan, Notes } from './entities/domain.mjs';

// 1. 业务拥有自己的形状和更新规则；Memory 只是现成的总结实体。
const plan = new Plan({ title: '准备发布', completed: 0 });
const notes = new Notes();
const note = notes.append({ title: '验收范围', text: '先验证公开包的独立消费。' });
const memories = new Memories();
const memory = memories.apply([{ action: 'create', value: { content: '用户希望例子简单，边界明确。' } }]).changed[0];

// 2. 单值对象只有一个 key；适配只负责读取，不替业务规定内容或版本规则。
const requirePlan = (key) => {
  if (key !== 'current') throw new RangeError('Unknown plan key');
  return plan.read();
};
const sources = {
  plan: createViewSource({
    id: plan.id,
    scope: 'whole',
    version: () => String(plan.read().basis.revision),
    keys: () => ['current'],
    inspect: (key) => ({ title: requirePlan(key).value.title }),
    read: requirePlan,
  }),
  notes: createViewSource({
    id: notes.id,
    scope: 'whole',
    version: () => notes.version,
    keys: () => notes.keys(),
    inspect: (key) => ({ title: notes.read(key).value.title }),
    read: (key) => notes.read(key),
  }),
  memory: new MemoryViewSource(memories),
};
const view = new View({
  revision: 0,
  sources: { plan: { id: plan.id, scope: 'whole' }, notes: { id: notes.id, scope: 'whole' }, memory: { id: memories.id, scope: 'whole' } },
  members: [
    { source: 'plan', key: 'current' },
    { source: 'notes', key: note.id },
    { source: 'memory', key: memory.id },
  ],
});

// 3. 登记普通资源。查看材料和修改业务是两个独立申请。
const materials = new ResourceOffer({ expose: ({ view, sources }, activity) => openView(view, sources, activity) });
const plans = new ResourceOffer({
  methods: {
    revise(origin, { value, expected }) {
      return origin.revise(value, expected);
    },
  },
});
const resources = new Resources().register(new Resource({ view, sources }), materials).register(new Resource(plan), plans);
const prepare = new Node({
  deps: { materials: materials.request(), plan: plans.request() },
  async run(work) {
    const snapshot = await work.resources.materials.capture();
    const previous = snapshot.entries.find((entry) => entry.source === 'plan').value;
    await work.resources.plan.revise({ value: { ...previous.value, completed: previous.value.completed + 1 }, expected: previous.basis });
    return snapshot; // 已取得的材料保持原值，与业务对象后续更新分开。
  },
});
const runner = new Runner(new Scene(prepare), resources).build();
const before = await view.index(sources);
const first = await runner.run();

// 4. 新材料不会自动纳入 View，哪些值得保留由业务策略选择。
const nextNote = notes.append({ title: '已完成验收', text: '公开入口可以独立安装并运行。' });
memories.apply([{ action: 'update', memoryId: memory.id, value: { content: '公开包已验收，下一步整理发布说明。' } }]);
view.includeSync(sources, [{ source: 'notes', key: nextNote.id }]);
const second = await runner.run();

assert.equal(first.entries[0].value.value.completed, 0);
assert.equal(second.entries[0].value.value.completed, 1);
assert.equal(plan.read().value.completed, 2);
assert.equal(first.entries[2].value.value.content, '用户希望例子简单，边界明确。');
await assert.rejects(view.capture(sources, before), (error) => error.code === 'VIEW_CONFLICT');
console.log('三种实体共享一条读取链：', first.entries.map((entry) => entry.source).join(' / '));
console.log('两次材料中的完成数：0 → 1；业务对象当前完成数：2。');
console.log(`明确纳入新材料后，成员数：${first.entries.length} → ${second.entries.length}。旧依据拒绝，旧材料不变。`);

// 可选 CP／记录的接线与边界见 docs/custom-entities.md。
// 保存材料不等于保存或回滚这三个实体，更不等于可以安全重做 revise。
