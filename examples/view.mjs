import assert from 'node:assert/strict';
// 运行：pnpm build && node examples/view.mjs
// 全部使用内存数据。本例准备材料并维护视图，不调用外部模型。
import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';
import { View, openView, openViewManager } from '@weiliang0121/capix-view';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Scene, Sequence } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { createSkillSource } from './view/skills.mjs';

// 1. 宿主建立独立实体。消息与记忆继续由各自实体管理。
const transcript = new Transcript([
  { role: 'user', content: '翻译时请用简短的中文。' },
  { role: 'assistant', content: '好的，我会简短回答。' },
]);
const memories = new Memories();
const {
  changed: [preference],
} = memories.apply([
  {
    action: 'create',
    reason: '记录用户明确表达的翻译偏好',
    value: { content: '使用简短的中文。' },
  },
]);

// 2. 来源提供 index / inspect / read / check；槽位名只在这个 View 内使用。
const sources = {
  messages: new TranscriptViewSource(transcript),
  memories: new MemoryViewSource(memories),
  skills: createSkillSource(),
};
const view = new View({
  revision: 0,
  sources: {
    messages: { id: sources.messages.id, scope: sources.messages.scope },
    memories: { id: sources.memories.id, scope: sources.memories.scope },
    skills: { id: sources.skills.id, scope: sources.skills.scope },
  },
  members: [
    { source: 'messages', key: 0 },
    { source: 'messages', key: 1 },
    { source: 'memories', key: preference.id },
    { source: 'skills', key: 'translate' },
  ],
});

// 3. 资源适配显式连接 View、来源与当前访问窗口。
// 同一材料提供 read/manage 两种操作；read 端点不能修改成员。
const material = new Resource({ view, sources });
const read = new ResourceOffer({
  expose: ({ view, sources }, activity) => openView(view, sources, activity),
});
const manage = new ResourceOffer({
  expose: ({ view, sources }, activity) => openViewManager(view, sources, activity),
});
const resources = new Resources().register(material, read).register(material, manage);

// 4. 业务节点只申请所需操作，不取得原始实体或来源适配器。
const prepare = new Node({
  deps: { context: read.request() },
  async run(work) {
    const index = await work.resources.context.index(); // 当前成员的摘要与版本依据。
    const snapshot = await work.resources.context.capture(index); // 按同一依据读取正文。
    // 后续模型节点可以按业务规则把 input 和 snapshot 组织成模型请求。
    return { input: work.input, snapshot };
  },
});
const maintain = new Node({
  deps: { context: manage.request() },
  run(work) {
    const index = work.resources.context.index();
    // 本例自定的后处理策略：旧助手消息退出视图。框架不预设这个规则。
    const members = index.entries.filter((entry) => entry.source !== 'messages' || entry.summary.role !== 'assistant').map(({ source, key }) => ({ source, key }));
    work.resources.context.apply({ basis: index.basis, members });
    // 这次已经取得的 snapshot 保持不变；成员调整影响下一次捕获。
    return work.input;
  },
});

// 5. 顺序预设组合业务节点，Runner 装配结构与资源，再启动调用。
const scene = new Scene(new Sequence([prepare, maintain]));
const runner = new Runner(scene, resources).build();
const first = await runner.run('hello');
const second = await runner.run('good morning');

console.log('第一次准备的材料：');
console.table(first.snapshot.entries.map(({ source, value }) => ({ source, content: value.content ?? value.value?.content ?? value.instructions })));
console.log(`两次捕获的成员数：${first.snapshot.entries.length} → ${second.snapshot.entries.length}`);
console.log(`原始实体仍保留：${transcript.length} 条消息、${memories.values().length} 条记忆`);
console.log(`首份快照仍包含：${first.snapshot.entries.length} 项`);
console.log(`视图修订：${view.exportState().revision}（第二次维护没有成员变化，不增加修订）`);

assert.equal(first.snapshot.entries.length, 4);
assert.equal(second.snapshot.entries.length, 3);
assert.equal(first.snapshot.entries.filter((entry) => entry.source === 'messages').length, 2);
assert.equal(second.snapshot.entries.filter((entry) => entry.source === 'messages').length, 1);
assert.equal(transcript.length, 2);
assert.equal(memories.values().length, 1);
assert.equal(view.exportState().revision, 1);
assert.equal(runner.isRunning, false);
