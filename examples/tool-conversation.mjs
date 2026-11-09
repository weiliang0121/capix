// pnpm build && node examples/tool-conversation.mjs
// 使用生产包的离线装配。固定 HTTP 样本只验证工具协议，不评价模型质量。
import { z } from 'zod';
import { Node } from '@weiliang0121/capix-structure';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Runner } from '@weiliang0121/capix-runtime';
import { Transcript } from '@weiliang0121/capix-transcript';
import { Memories } from '@weiliang0121/capix-memory';
import { View } from '@weiliang0121/capix-view';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { CompletionInteraction, createConversationScene, createMaterialPreparation } from '@capix/conversation-service';
import { createConversationInteractions, createConversationResources } from '@capix/conversation-service/assembly';
import { tool, createToolLoop, createToolAnswer, registerToolLoopResources } from '@capix/conversation-service/tools';

// 资源与节点仍按原心智构造；工具目录是这个节点的协议说明。
const dictionary = new ResourceOffer({
  methods: {
    translate(origin, word) {
      return origin.get(word) ?? word;
    },
  },
});
const translate = new Node({ deps: { dictionary: dictionary.request() }, run: (work) => work.resources.dictionary.translate(work.input.word) });
const loop = createToolLoop({ policyVersion: 'dictionary-v1', tools: { translate: tool(translate, { description: 'Translate one English word into Chinese.', input: z.strictObject({ word: z.string() }), result: { succeeded: (text) => ({ status: 'ok', content: [{ kind: 'text', text }] }) } }) } });
const transcript = new Transcript();
const memories = new Memories(transcript);
const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
const exchanges = new ModelExchanges();
let requests = 0;
const model = new ChatCompletionsProvider({
  endpoint: 'https://fixture.invalid/chat/completions',
  apiKey: 'offline-fixture',
  model: 'fixture',
  fetch: async (_url, init) => {
    requests++;
    const request = JSON.parse(init.body);
    const feedback = request.messages.findLast((message) => message.role === 'tool');
    const message = feedback ? { role: 'assistant', content: `hello 的中文是“${JSON.parse(feedback.content).content[0].text}”。` } : { role: 'assistant', content: null, tool_calls: [{ id: 'translate-1', type: 'function', function: { name: 'translate', arguments: JSON.stringify({ word: 'hello' }) } }] };
    return Response.json({ id: `reply-${requests}`, model: 'fixture', choices: [{ index: 0, message, finish_reason: feedback ? 'stop' : 'tool_calls' }] });
  },
});
const interactions = createConversationInteractions(model);
const resources = createConversationResources({ transcript, memories, view }, model).register(new Resource(new Map([['hello', '你好']])), dictionary);
registerToolLoopResources(resources, loop, exchanges, interactions.bind(CompletionInteraction));
const scene = createConversationScene(createToolAnswer(loop), createMaterialPreparation());
const runner = new Runner(scene, resources, interactions).build();
try {
  console.log(await runner.run('hello 是什么意思？请查词典。'));
  console.log({ modelRequests: requests, messages: transcript.length, exchanges: exchanges.snapshot().entries.length });
  // Transcript 只有正式问答；工具请求、反馈和准确接纳来源在独立交换实体。
  console.log(exchanges.snapshot().entries[0].feedback);
} finally {
  await interactions.settled();
  interactions.close();
}
