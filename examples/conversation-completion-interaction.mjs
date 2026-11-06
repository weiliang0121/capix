// pnpm build && node examples/conversation-completion-interaction.mjs
// 固定模型替身；验证完整模型请求、材料回答与独立交互的组合，不访问网络。
import assert from 'node:assert/strict';
import { CompletionInteraction, CompletionInteractionResource, ConversationViewResource, createCompletionStartNode, createCompletionReplyNode, createConversationScene, createInteractionCompletion, createMaterialAnswer, createMaterialPreparation, createMessageInclusion } from '@capix/conversation-service';
import { Interactions } from '@capix/interaction';
import { Memories } from '@capix/memory';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Scene } from '@capix/structure';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View } from '@capix/view';

const delayed = Promise.withResolvers();
const previewed = Promise.withResolvers();
const requests = [];
let emitLater;
const reply = (text) => ({ id: 'offline-reply', model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });
const model = {
  async complete(request, { emit } = {}) {
    requests.push(request);
    if (request.messages.at(-1).content === '独立读取验证') {
      emitLater = emit;
      emit?.('已经产生的预览。');
      return delayed.promise;
    }
    emit?.('正在使用固定材料。');
    return reply('依据你的偏好，使用简短中文回答。');
  },
};

// 发送者属于宿主登记。不捕获一次调用的 signal 或 operation.emit。
// 真实模型可替换为 ChatCompletionsProvider，由其自己的总超时管理外部请求。
const interactions = new Interactions().register(CompletionInteraction, {
  send(request, { publish }) {
    return model.complete(request, request.stream ? { emit: (delta) => void publish(delta) } : {});
  },
});

// 1. 已有材料策略与 Scene 不变，只为回答选装另一种普通 completion 子结构。
const transcript = new Transcript([{ role: 'user', content: '请使用简短中文回答。' }]);
const memories = new Memories(transcript);
const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [{ source: 'messages', key: 0 }] });
const content = new Resource({ transcript, memories, view });
const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(content, ConversationViewResource.read).register(content, ConversationViewResource.manage).registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
const scene = createConversationScene(createMaterialAnswer(createInteractionCompletion()), createMaterialPreparation(), createMessageInclusion());
const runner = new Runner(scene, resources, interactions).build();
const stopPreview = runner.output.subscribe({ receive: (event) => void (event.kind === 'delta' && console.log('材料回答预览：', event.delta)) });
try {
  const answer = await runner.run('我希望你怎样回答？');
  assert.equal(requests[0].messages[0].role, 'system');
  assert.equal(requests[0].maxTokens, 1200);
  assert.equal(transcript.snapshot().at(-1).content, answer);
  console.log('正式回答：', answer);
} finally {
  stopPreview();
}

// 2. 若需要跨调用继续，先正式交付引用，由宿主明确保留。
// 这里不从 observation 猜引用，也不依赖取消异常携带业务关联。
const starter = new Runner(new Scene(createCompletionStartNode()), new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction), interactions).build();
const reference = await starter.run({
  messages: [
    { role: 'system', content: '只输出回答正文。' },
    { role: 'user', content: '独立读取验证' },
  ],
  stream: true,
  maxTokens: 100,
  temperature: 0,
});
const reading = new Scene({ output: { result: (value) => value, delta: (value) => value } }).add({ read: createCompletionReplyNode() });
reading.run = (work) => work.children.read.invoke(work.input, { delta: (value) => work.output.emit(value) });
const reader = new Runner(reading, new Resources().registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction), interactions).build();
const oldPreview = [];
const stopOldPreview = reader.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') {
      oldPreview.push(event.delta);
      previewed.resolve();
    }
  },
});
try {
  const running = reader.run(reference);
  const cancelled = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
  await previewed.promise;
  reader.cancel();
  await cancelled;
  assert.equal(interactions.active, true);
  emitLater('旧调用结束后仍产生的预览。');
  delayed.resolve(reply('外部请求的最终回复。'));
  await interactions.settled();
  assert.deepEqual(oldPreview, ['已经产生的预览。']);
} finally {
  stopOldPreview();
  // 示例断言失败时也让宿主持有的模拟发送结束。
  delayed.resolve(reply('外部请求的最终回复。'));
}

// 同一 Runner 的下一次 run 是新的调用；仅有读取授权，不能再次发送。
// 从头重建预览，不把回放直接拼接到旧预览。
const replay = [];
const stopReplay = reader.output.subscribe({ receive: (event) => void (event.kind === 'delta' && replay.push(event.delta)) });
try {
  const result = await reader.run(reference);
  assert.equal(requests.length, 2, '两个独立示例各发送一次，重读没有第三次发送');
  assert.deepEqual(replay, ['已经产生的预览。', '旧调用结束后仍产生的预览。']);
  assert.deepEqual(result, reply('外部请求的最终回复。'));
  assert.equal(transcript.length, 3, '单独读取不自动写回原对话');
  console.log('新调用读取完整回复：', result);
  console.log('最终读取保留 termination 与 usage；是否接纳、写入哪个对话由业务决定。');
} finally {
  stopReplay();
  await interactions.settled();
  interactions.close();
}
