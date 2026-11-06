// pnpm build && node examples/conversation-memory.mjs
// 固定响应仅验证离线装配和身份传递，不代表模型提取质量；不读取环境或调用真实模型。
import { CompletionResource, ConversationMemoryResource, ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation, createMemoryMaintenance, createMessageInclusion } from '@capix/conversation-service';
import { Memories, MemoryResource, MemoryViewSource } from '@capix/memory';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Group } from '@capix/structure';
import { Transcript, TranscriptResource, TranscriptViewSource } from '@capix/transcript';
import { View } from '@capix/view';

// 1. 宿主持有正式实体。记忆从空集合开始，由后面的普通维护结构提议并写入。
const transcript = new Transcript();
const memories = new Memories(transcript);
const sources = { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) };
const view = new View({
  revision: 0,
  sources: { messages: { id: sources.messages.id, scope: sources.messages.scope }, memories: { id: sources.memories.id, scope: sources.memories.scope } },
  members: [],
});

// 2. 同一模型能力承接回答和提取；两个业务节点各自决定请求表示与结果接纳。
// 替身按真实请求载荷生成固定提案：新建不给 ID，更新使用 capture 返回的实体 ID。
const requests = ['以后请用简短中文回答。', '仍用简短中文，并先给结论。', '保持简短中文和结论优先，必要时列点。'];
const preferences = ['使用简短中文回答。', '使用简短中文回答，先给结论。', '使用简短中文回答，先给结论，必要时列点。'];
const answerInputs = [];
const extractionInputs = [];
const reply = (text) => ({ id: 'offline-completion', model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });
const model = {
  async complete(request, { emit } = {}) {
    const input = JSON.parse(request.messages[1].content);
    if (request.responseFormat === 'text') {
      answerInputs.push(input);
      const remembered = input.materials.entries.find((entry) => entry.source === 'memories');
      const prefix = '已收到本次要求。';
      const content = `本次记忆材料：${remembered?.value.content ?? '无。'}`;
      if (request.stream) {
        emit?.(prefix);
        emit?.(content);
      }
      return reply(prefix + content);
    }
    if (request.responseFormat !== 'json_object') throw new Error('Unexpected offline response format');
    extractionInputs.push(input);
    const latest = input.messages.findLast(({ message }) => message.role === 'user');
    const round = requests.indexOf(latest.message.content);
    if (round < 0) throw new Error('Unexpected offline extraction input');
    const previous = input.memories[0];
    const sourceIndexes = [...new Set([...(previous?.sourceIndexes ?? []), latest.index])];
    return reply(JSON.stringify({ changes: [{ action: previous ? 'update' : 'create', memoryId: previous?.id ?? null, change: '接纳本轮明确的表达偏好', sourceIndexes: [latest.index], result: { topic: '表达偏好', content: preferences[round], sourceIndexes } }] }));
  },
};

// 3. 两个策略都是普通成员。消息纳入在每次追加后执行；记忆维护仅在正式助手回答后提取。
// 策略决定提案，Memories 校验并保存正式内容，View 保存被选择的真实引用。
const maintain = new Group({ name: 'maintain-conversation-content' }).add({ include: createMessageInclusion(), remember: createMemoryMaintenance() });
maintain.run = async (work) => {
  await work.children.include.invoke(work.input);
  await work.children.remember.invoke(work.input);
};
const materials = new Resource({ view, transcript, memories });
const memory = new Resource(memories);
const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(materials, ConversationViewResource.read).register(materials, ConversationViewResource.manage).register(memory, ConversationMemoryResource).register(memory, MemoryResource.apply).register(new Resource(model), CompletionResource);
const scene = createConversationScene(createMaterialAnswer(), createMaterialPreparation(), maintain);
const runner = new Runner(scene, resources).build();
runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') console.log('回答预览：', event.delta);
  },
});

// 4. 首次回答后，实体生成 ID；维护策略只将实际新建的记忆 ID 纳入 View。
console.log('第一次回答：', await runner.run(requests[0]));
const initial = memories.snapshot()[0];
console.log('首次提取并纳入：', { id: initial.id, content: initial.content, included: view.has({ source: 'memories', key: initial.id }) });

// 第二次准备读取第一次已纳入的记忆，回答后的提取更新同一实体。
console.log('第二次回答：', await runner.run(requests[1]));
const captured = answerInputs[1].materials.entries.find((entry) => entry.source === 'memories');
console.log('第二次实际读取：', { key: captured.key, content: captured.value.content });
console.log('更新保留原 ID：', { sameId: memories.snapshot()[0].id === initial.id, content: memories.get(initial.id).content });
console.log('此前捕获保持原值：', captured.value.content);

// 5. 退出成员不删除记忆。提取读取实体全集，因此仍能更新该 ID，但更新不会自动把它纳回 View。
view.excludeSync([{ source: 'memories', key: initial.id }]);
console.log('第三次回答：', await runner.run(requests[2]));
console.log('退出后的读取与维护：', {
  answerMemoryCount: answerInputs[2].materials.entries.filter((entry) => entry.source === 'memories').length,
  extractionKeepsId: extractionInputs[2].memories[0].id === initial.id,
  entityCount: memories.values().length,
  content: memories.get(initial.id).content,
  included: view.has({ source: 'memories', key: initial.id }),
});

// 正式消息追加、记忆写入与 View 纳入分别提交；本例没有跨实体事务、自动重试或隐藏补纳入。
