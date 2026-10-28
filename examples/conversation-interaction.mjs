import assert from 'node:assert/strict';
import { createConversationScene, createInteractionAnswer, createModelReplyNode, HistoryResource, ModelInteractionResource, TextModelInteraction } from '@capix/conversation-service';
import { Interactions } from '@capix/interaction';
import { Resource } from '@capix/resources';
import { Resources, Runner, Scene } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

// All external work is simulated locally. The host owns the sender and the exchange lifetime.
const previewed = Promise.withResolvers();
const reply = Promise.withResolvers();
let reference;
let sends = 0;
let publish;
const interactions = new Interactions().register(TextModelInteraction, {
  send(_history, controls) {
    sends++;
    publish = controls.publish;
    publish('先产生的预览。');
    return reply.promise;
  },
  observation: {
    receive(event) {
      if (event.type === 'changed') reference = { id: event.state.id, contract: event.state.contract };
    },
  },
});
const transcript = new Transcript();
const messages = new Resource(transcript);
const resources = new Resources().register(messages, TranscriptResource.append).register(messages, HistoryResource).registerInteraction(ModelInteractionResource.start, TextModelInteraction).registerInteraction(ModelInteractionResource.feedback, TextModelInteraction);
const scene = createConversationScene(createInteractionAnswer());
const runner = new Runner(scene, resources, interactions).build();
runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') {
      console.log('原调用预览：', event.delta);
      previewed.resolve();
    }
  },
});

const running = runner.run('请回答这个问题');
const stopped = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
await previewed.promise;
runner.cancel();
await stopped;
console.log('本次调用已停止：', !runner.isRunning, '外部交互仍在继续：', interactions.active);

// The original call has ended, but its external exchange can still receive its final reply.
publish('调用结束后仍可产生的预览。');
reply.resolve('晚到的模型回答');
await interactions.settled();

// Grant only feedback reading to a new invocation. Reading cannot dispatch another request.
const readerResources = new Resources().registerInteraction(ModelInteractionResource.feedback, TextModelInteraction);
const reading = new Scene({ output: { result: (value) => value, delta: (value) => value } }).add({ read: createModelReplyNode() });
reading.run = (work) => work.children.read.invoke(work.input, { delta: (value) => work.output.emit(value) });
const reader = new Runner(reading, readerResources, interactions).build();
reader.output.subscribe({ receive: (event) => void (event.kind === 'delta' && console.log('新调用从头重建预览：', event.delta)) });
const result = await reader.run(reference);
assert.equal(sends, 1);
assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: '请回答这个问题' }]);
console.log('重新读取：', result, '发送次数：', sends);
console.log('读取不会自动把晚到回答写回原对话。');
interactions.close();
