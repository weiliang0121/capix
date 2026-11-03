// pnpm build && node examples/conversation-materials.mjs
// 离线验证实体、View 与服务装配；固定模型替身不代表真实模型质量。
import { CompletionResource, ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation } from '@capix/conversation-service';
import { Memories, MemoryViewSource } from '@capix/memory';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource, TranscriptViewSource } from '@capix/transcript';
import { View } from '@capix/view';

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
    const message = input.materials.entries.find((entry) => entry.source === 'messages');
    const memory = input.materials.entries.find((entry) => entry.source === 'memories');
    return { id: `offline-${received.length}`, model: 'offline', text: `依据：${message?.value.content ?? '无历史消息'}；偏好：${memory?.value.content ?? '无记忆'}。`, finishReason: 'stop', usage: null };
  },
};

// 4. 各资源分别登记。准备节点只有 View 读取权限，回答节点只有模型权限。
const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource({ view, transcript, memories }), ConversationViewResource).register(new Resource(model), CompletionResource);
const scene = createConversationScene(createMaterialAnswer(), createMaterialPreparation());
const runner = new Runner(scene, resources).build();

console.log('第一次回答：', await runner.run('目前的发布安排是什么？'));
console.log('本次请求定位：', received[0].query);
console.table(received[0].materials.entries.map(({ source, key, value }) => ({ source, key, content: value.content })));

// 5. 宿主明确调整下一次的材料：只保留刚才的正式回答和记忆。
// 退出 View 不删除实体；新消息也不会自动进入 View。
const index = view.indexSync(sources);
view.applySync(sources, {
  basis: index.basis,
  members: [
    { source: 'messages', key: transcript.length - 1 },
    { source: 'memories', key: preference.id },
  ],
});
console.log('第二次回答：', await runner.run('根据刚才的正式回答继续说明。'));
console.log(
  '前后捕获的消息索引：',
  received.map((input) => input.materials.entries.filter((entry) => entry.source === 'messages').map((entry) => entry.key)),
);
console.log('第一份材料仍然不变：', received[0].materials.entries[0].value.content);
console.log('原始实体仍保留：', { messages: transcript.length, memories: memories.values().length });
