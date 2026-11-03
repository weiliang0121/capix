import assert from 'node:assert/strict';
import { createCompletionReplyNode, CompletionInteractionResource, CompletionInteraction } from '@capix/conversation-service';
import { PersistenceError } from '@capix/diagnostics';
import { Interactions } from '@capix/interaction';
import { Resource } from '@capix/resources';
import { Node, Scene } from '@capix/structure';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

// 本地故障注入：不访问真实模型或数据库。两个存储端口独立提交，没有跨实体事务。
const savedInteractions = new Map();
const savedMessages = [];
const messageFailure = new PersistenceError('transcript.append', new Error('模拟消息提交前失败'));
let messageRevision = 0;
let failNextAnswer = false;
let sends = 0;
const transcript = new Transcript([{ role: 'user', content: '请给出发布安排。' }], {
  persistence: {
    commit(change) {
      assert.equal(change.kind, 'append');
      assert.equal(change.expectedRevision, messageRevision);
      if (failNextAnswer && change.messages.some((message) => message.role === 'assistant')) {
        failNextAnswer = false;
        throw messageFailure;
      }
      savedMessages.push(...structuredClone(change.messages));
      messageRevision = change.revision;
    },
  },
});
const interactions = new Interactions().register(CompletionInteraction, {
  send() {
    sends++;
    return { id: 'saved-reply', model: 'local-demo', text: '周四复核，周五发布。', finishReason: 'stop', usage: null };
  },
  persistence: {
    create(state) {
      assert.equal(savedInteractions.has(state.id), false);
      savedInteractions.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      assert.equal(savedInteractions.get(state.id).revision, expectedRevision);
      savedInteractions.set(state.id, structuredClone(state));
    },
    read(id) {
      return savedInteractions.get(id);
    },
  },
});

// 发送者通过正式返回值把引用交给宿主。观测不是恢复所需依据的保存入口。
const start = new Node({ deps: { requests: CompletionInteractionResource.start.request() }, run: (work) => work.resources.requests.start(work.input) });
const sender = new Runner(new Scene(start), new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction), interactions).build();

// 消费者只有读取反馈和追加消息的权限，无法重新发送。
const accepting = new Scene({ deps: { messages: TranscriptResource.append.request() } }).add({ read: createCompletionReplyNode(0) });
accepting.run = (work) =>
  work.children.read.invoke(work.input, {
    result: {
      succeeded(reply) {
        if (reply.finishReason !== 'stop' || !reply.text.trim()) throw new Error('模型回答不完整');
        const text = reply.text;
        work.resources.messages.append([{ role: 'assistant', content: text }]);
        return text;
      },
    },
  });
const consumer = new Runner(accepting, new Resources().register(new Resource(transcript), TranscriptResource.append).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction), interactions).build();

try {
  // 引用归宿主持有。此处只是内存变量，未承诺发起交互与保存引用的原子提交。
  const reference = await sender.run({ messages: transcript.snapshot() });
  await interactions.settled();
  const feedback = structuredClone(savedInteractions.get(reference.id).feedback);
  failNextAnswer = true;
  await assert.rejects(consumer.run(reference), (error) => error === messageFailure);
  assert.equal(consumer.isRunning, false);
  assert.equal(transcript.length, 1);
  assert.equal(savedMessages.length, 1);
  assert.deepEqual(savedInteractions.get(reference.id).feedback, feedback);
  console.log('第一次消费失败：消息未写入，外部反馈仍保留；发送次数', sends);

  // 新的 Invocation，继续读取同一反馈；不复活上一调用，不重放发送节点。
  const answer = await consumer.run(reference);
  assert.equal(answer, feedback.payload.text);
  assert.equal(transcript.length, 2);
  assert.deepEqual(savedMessages, transcript.snapshot());
  assert.equal(sends, 1);
  console.log('第二次消费成功：', answer, '；发送次数', sends, '；助手消息数', transcript.length - 1);

  // 有意探测边界：消费过的反馈仍可读取，普通 append 没有跨调用去重依据。
  await consumer.run(reference);
  assert.equal(sends, 1);
  assert.equal(transcript.length, 3);
  console.log('再次接纳同一反馈：发送仍为 1 次，但普通 append 产生了第 2 条助手消息。');
  console.log('结论：重读不重发已经成立；跨调用只落实一次尚需明确的业务依据。');
} finally {
  await interactions.settled();
  interactions.close();
}
