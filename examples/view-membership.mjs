// pnpm build && node examples/view-membership.mjs
// 已知引用的维护策略：通过原子操作修改成员，不先读取所有材料。
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { View, openViewManager } from '@weiliang0121/capix-view';

const transcript = new Transcript([{ role: 'user', content: '旧话题：介绍一下这个项目。' }]);
const sources = { messages: new TranscriptViewSource(transcript) };
const view = new View({
  revision: 0,
  sources: { messages: { id: sources.messages.id, scope: sources.messages.scope } },
  members: [{ source: 'messages', key: 0 }],
});
const before = view.captureSync(sources);

// 宿主连接实体与来源。只把受控的管理端点提供给策略节点。
const manage = new ResourceOffer({ expose: ({ view, sources }, activity) => openViewManager(view, sources, activity) });
const resources = new Resources().register(new Resource({ view, sources }), manage);

// 策略只决定哪些消息纳入或退出；去重、顺序、来源核验由 View 完成。
// 这里的两个操作分别提交；如果策略需要基于快照整体筛选或重排，使用 apply。
const maintain = new Node({
  deps: { view: manage.request() },
  run(work) {
    work.resources.view.include(work.input.appended.map((key) => ({ source: 'messages', key })));
    work.resources.view.exclude(work.input.retired.map((key) => ({ source: 'messages', key })));
    return work.resources.view.members();
  },
});
const runner = new Runner(new Scene(maintain), resources).build();

// 正式写入与视图维护分开。业务提供刚落实的索引，无需重新扫描历史。
transcript.append({ role: 'user', content: '现在讨论资源包。' }, { role: 'assistant', content: 'Resource 保存实体，Offer 定义访问操作。' });
const decision = { appended: [1, 2], retired: [0] };
console.log('维护后的成员：', await runner.run(decision));
const revision = view.exportState().revision;
await runner.run(decision);
console.log(`重复执行没有变更：revision ${revision} → ${view.exportState().revision}`);
console.log(
  '当前材料：',
  view.captureSync(sources).entries.map((entry) => entry.value.content),
);
console.log(
  '此前快照仍是：',
  before.entries.map((entry) => entry.value.content),
);
console.log(`来源仍保留 ${transcript.length} 条正式消息；退出视图不删除消息。`);
