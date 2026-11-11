import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Resource } from '@weiliang0121/capix-resources';
import { Scene, Node } from '@weiliang0121/capix-structure';
import { Runner, Resources } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { requireModelRequest, requireModelReply } from '@weiliang0121/capix-model-provider';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { Tool, ToolModelResource } from '@weiliang0121/capix-tool';

// Node 仍是普通处理结构；Tool 从同一份登记生成目录并组织成员调用。
export function createToolRunner(provider) {
  const translate = new Node({ run: (work) => ({ hello: '你好' })[work.input.word] ?? work.input.word });
  const tool = new Tool({
    policyVersion: 'dictionary.v1',
    tools: {
      translate: {
        node: translate,
        description: 'Translate a word into Chinese.',
        input: z.strictObject({ word: z.string() }),
        result: { succeeded: (text) => ({ status: 'ok', content: [{ kind: 'text', text }] }) },
      },
    },
  });

  // 宿主登记独立交互；取消一次调用的等待，不会取消这个发送者。
  const contract = { key: 'example.tool.model.v1', request: requireModelRequest, reply: requireModelReply };
  const interactions = new Interactions().register(contract, { send: (request) => provider.complete(request) });
  const exchanges = new ModelExchanges();
  const resources = new Resources().register(new Resource(exchanges), ModelExchangeResource).register(new Resource({ exchanges, channel: interactions.bind(contract), ...(provider.inspectRequest ? { inspection: provider } : {}) }), ToolModelResource);
  return new Runner(new Scene(tool), resources, interactions).build();
}

// 离线协议示例：第一次请求选择工具，第二次使用真实工具反馈回答。
// 换成配置好的 ChatCompletionsProvider 后，Tool、节点和资源登记不变。
const offlineModel = {
  async complete(request) {
    const feedback = request.exchanges?.at(-1)?.feedback[0];
    return {
      formatVersion: 1,
      id: feedback ? 'answer' : 'choose-tool',
      model: 'offline-example',
      output: feedback ? feedback.content : [{ kind: 'tool-call', id: 'lookup', name: 'translate', arguments: { encoding: 'json-text', text: '{"word":"hello"}' } }],
      termination: { kind: 'completed', reason: feedback ? 'stop' : 'tool_calls' },
      usage: null,
      native: { format: 'chat-completions', version: 1 },
    };
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runner = createToolRunner(offlineModel);
  console.log(await runner.run({ request: { messages: [{ role: 'user', content: 'Translate hello.' }] } }));
}
