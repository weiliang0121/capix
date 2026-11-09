import assert from 'node:assert/strict';
import { CompletionResource, createConversationScene, createHistoryAnswer, HistoryResource } from '@capix/conversation-service';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { Resource } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

// 默认离线固定响应，只验证材料交接与结果落实；--live 才会请求真实模型。
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--live')) throw new Error('Usage: node examples/conversation-history.mjs [--live]');
const live = args.includes('--live');
const provider = live
  ? new ChatCompletionsProvider({ endpoint: 'https://api.deepseek.com/chat/completions', apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', thinking: 'disabled', timeoutMs: 45_000 })
  : {
      async complete(request) {
        const input = JSON.parse(request.messages[1].content);
        // 这是示例脚本响应，不是框架的意图算法，也不用于评价模型质量。
        const text = request.responseFormat === 'json_object' ? JSON.stringify({ kind: input.query.includes('再短') ? 'revise_answer' : 'summarize_history', question: null }) : input.answer ? '周四完成复核，周五发布。' : '已确认周四完成代码复核，周五发布；发布前仍需完成复核。';
        return { id: 'scripted', model: 'scripted-wiring-only', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
      },
    };

const requests = [];
const model = {
  complete(request, controls) {
    requests.push({ format: request.responseFormat, input: JSON.parse(request.messages[1].content) });
    return provider.complete(request, controls);
  },
};

function build(transcript) {
  const messages = new Resource(transcript);
  const resources = new Resources().register(messages, TranscriptResource.append).register(messages, HistoryResource).register(new Resource(model), CompletionResource);
  // Scene 继续负责消息落实；回答 Group 负责理解、形成输入并选择真正执行的子节点。
  return new Runner(createConversationScene(createHistoryAnswer()), resources).build();
}

console.log(live ? '真实模型模式：最多 5 次请求，无自动重试。' : '离线模式：只验证接线，不代表意图识别或总结质量。');

// 当前请求虽然已经写入 Transcript，却不是“此前讨论”。没有材料时只形成澄清。
const empty = new Transcript();
const emptyRunner = build(empty);
console.log('没有此前历史：', await emptyRunner.run('请总结此前的讨论。'));
assert.equal(requests.filter((request) => request.format === 'text').length, 0);
assert.equal(empty.snapshot().length, 2, '澄清作为真实助手回复写入');

const transcript = new Transcript([
  { role: 'user', content: '发布日期定在周五，我们还需要完成代码复核。' },
  { role: 'assistant', content: '建议周四完成复核，周五发布。' },
  { role: 'user', content: '同意，按这个时间安排。' },
]);
const runner = build(transcript);
const summary = await runner.run('请总结我们已经确定的发布安排。');
console.log('正式总结：', summary);
assert.equal(transcript.snapshot().at(-1).content, summary);

// 第二次是新的独立调用。它读取已经落实的回答，不依靠闭包保存待办或候选文本。
const revision = await runner.run('再短一些，只保留一句话。');
console.log('后续改写：', revision);
const executed = requests.filter((request) => request.format === 'text');
assert.equal(executed.length, 2, '只执行一次总结和一次改写');
assert.equal(executed[0].input.history.length, 3, '总结材料不包含本次总结请求');
assert.equal(executed[1].input.answer.content, summary, '改写材料必须来自正式接纳的回答');
assert.equal(transcript.snapshot()[executed[1].input.answer.index].content, summary);
console.log('执行材料：', { summaryMessages: executed[0].input.history.length, revisedMessageIndex: executed[1].input.answer.index });
console.log('模型请求次数：', requests.length);
console.log(
  '正式消息：',
  transcript.snapshot().map((message, index) => ({ index, ...message })),
);
