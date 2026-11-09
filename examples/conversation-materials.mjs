// pnpm build && node examples/conversation-materials.mjs
// 离线验证实体、View 与服务装配；固定模型替身不代表真实模型质量。
import { CompletionResource, ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation, createMessageInclusion } from '@capix/conversation-service';
import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';
import { Resource } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Transcript, TranscriptResource, TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { View } from '@weiliang0121/capix-view';

// 1. 实体保存正式内容。记忆由宿主预置，本例没有自动提取策略。
const transcript = new Transcript([
  { role: 'user', content: '回复请用简短的中文。' },
  { role: 'assistant', content: '好的。' },
  { role: 'user', content: '周四复核代码，周五发布。' },
]);
const memories = new Memories(transcript);
const [preference] = memories.apply([{ action: 'create', memoryId: null, change: '记录明确偏好', sourceIndexes: [0], result: { topic: '表达偏好', content: '用简短中文回答。', sourceIndexes: [0] } }]);

// 2. View 选择材料；消息 key=2 仍是正式索引 2，不会变成数组位置 0。
const sources = { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) };
const view = new View({
  revision: 0,
  sources: { messages: { id: sources.messages.id, scope: sources.messages.scope }, memories: { id: sources.memories.id, scope: sources.memories.scope } },
  members: [
    { source: 'messages', key: 2 },
    { source: 'memories', key: preference.id },
  ],
});

// 3. 模型节点负责把固定 query/materials 转成请求。这里查看真实载荷再返回替身回答。
const received = [];
const model = {
  async complete(request) {
    const input = JSON.parse(request.messages[1].content);
    received.push(input);
    const message = input.materials.entries.findLast((entry) => entry.source === 'messages');
    const memory = input.materials.entries.find((entry) => entry.source === 'memories');
    return { id: `offline-${received.length}`, model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: `依据：${message?.value.content ?? '无历史消息'}；偏好：${memory?.value.content ?? '无记忆'}。` }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
  },
};

// 4. 宿主选装普通维护节点，在每次正式追加用户/助手消息后纳入该消息。
// 读取与管理分别登记；准备节点只读取，维护节点只管理，回答节点只申请模型。
const materials = new Resource({ view, transcript, memories });
const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(materials, ConversationViewResource.read).register(materials, ConversationViewResource.manage).register(new Resource(model), CompletionResource);
const scene = createConversationScene(createMaterialAnswer(), createMaterialPreparation(), createMessageInclusion());
const runner = new Runner(scene, resources).build();

console.log('第一次回答：', await runner.run('目前的发布安排是什么？'));
console.log('本次请求定位：', received[0].query);
console.table(received[0].materials.entries.map(({ source, key, value }) => ({ source, key, content: value.content })));
const firstCapture = JSON.stringify(received[0].materials);

// 5. 无需在两次提交之间重组 View 成员。策略已纳入前次用户消息和正式回答。
// 本次用户消息虽已纳入 View，prepare 仍把它作为 query，排除于此前材料之外。
console.log('第二次回答：', await runner.run('根据刚才的正式回答继续说明。'));
console.log(
  '前后捕获的消息索引：',
  received.map((input) => input.materials.entries.filter((entry) => entry.source === 'messages').map((entry) => entry.key)),
);
console.log('第一份材料仍然不变：', JSON.stringify(received[0].materials) === firstCapture);
console.log(
  '维护后的 View 消息成员：',
  view
    .members()
    .filter((member) => member.source === 'messages')
    .map((member) => member.key),
);
console.log('原始实体仍保留：', { messages: transcript.length, memories: memories.values().length });
