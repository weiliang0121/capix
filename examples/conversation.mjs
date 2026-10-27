import { createConversationScene, HistoryResource, ModelResource } from '@capix/conversation-service';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

// 宿主提供实体；示例模型只在本地返回文本，不连接外部服务。
const transcript = new Transcript();
const model = { generate: (messages) => `收到：${messages.at(-1).content}` };
const messages = new Resource(transcript);

// 同一个消息实体提供写入与历史读取；模型单独登记。
const resources = new Resources().register(messages, TranscriptResource.append).register(messages, HistoryResource).register(new Resource(model), ModelResource);

// 场景负责业务顺序，Runner 负责构建和本次运行。
const runner = new Runner(createConversationScene(), resources).build();
// 观察只消费元信息；入口的 settled 对应本次 run 的最终结果。
const unsubscribe = runner.observation.subscribe({
  receive(event) {
    if (event.source === 'entry' && event.fact.kind === 'settled') console.log('运行结束', event.entryId, event.fact.status);
  },
});
console.log(await runner.run('你好'));
console.log(await runner.run('继续聊聊'));
console.log(transcript.snapshot());
unsubscribe();
