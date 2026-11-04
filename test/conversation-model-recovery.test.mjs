import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { CompletionInteraction, CompletionInteractionResource, CompletionResource, ConversationViewResource, createCompletionNode, createInteractionCompletion, createMaterialAnswer, createMaterialPreparation } from '@capix/conversation-service';
import { Interactions } from '@capix/interaction';
import { Memories } from '@capix/memory';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Scene, checkpointPoint, childReference } from '@capix/structure';
import { Transcript } from '@capix/transcript';
import { View } from '@capix/view';

const clone = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const response = { id: 'saved-reply', model: 'offline', text: '正式回答', finishReason: 'stop', usage: null };
const material = {
  query: { transcriptId: 'messages', index: 1, content: '继续' },
  materials: { basis: { viewRevision: 3, sources: { messages: { id: 'messages', scope: 'whole', version: '2' }, memories: { id: 'memories', scope: 'whole', version: '0' } } }, entries: [{ source: 'messages', key: 0, value: { role: 'assistant', content: '前文' } }] },
};

class Journal extends MemoryCheckpointStore {
  writes = [];
  save(image, revision) {
    const head = super.save(image, revision);
    this.writes.push({ image: head.image, revision });
    return head;
  }
  finish(id, revision, delivery) {
    const head = super.finish(id, revision, delivery);
    this.writes.push({ id, revision, delivery: head.delivery });
    return head;
  }
}

function prefix(writes, end) {
  const store = new MemoryCheckpointStore();
  for (const write of writes.slice(0, end + 1)) {
    if (write.image) store.save(write.image, write.revision);
    else store.finish(write.id, write.revision, write.delivery);
  }
  return store;
}

function fixtureScene(child) {
  const point = checkpointPoint()({
    name: 'waiting',
    state: clone,
    references: { child: childReference(child) },
    resume: { uses: [child], run: (work, _state, refs) => work.children.resume(refs.child).invoke() },
  });
  const scene = new Scene({ output: { result: (value) => value, delta: (value) => value }, checkpoint: { key: 'fixture.model-recovery', version: 1, input: clone, output: clone, points: [point] } }).add({ child });
  scene.run = (work) => {
    const call = work.children.create(child, work.input, {
      key: 'child',
      output: {
        receive(event) {
          if (event.kind === 'delta') work.output.emit(event.delta);
        },
      },
    });
    work.checkpoint({ point, state: {}, refs: { child: call.ref } });
    return call.invoke();
  };
  return scene;
}

function modelHarness(store, persistence, send, child = createMaterialAnswer(createInteractionCompletion({ waitMs: 100 }))) {
  const interactions = new Interactions().register(CompletionInteraction, { persistence, send });
  const resources = new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  const runner = new Runner(fixtureScene(child), resources, interactions, { checkpoints: { store } }).build();
  return { runner, interactions };
}

function persistence() {
  const values = new Map();
  return {
    values,
    create(state) {
      values.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      assert.equal(values.get(state.id).revision, expectedRevision);
      values.set(state.id, structuredClone(state));
    },
    read: (id) => values.get(id),
  };
}

for (const [contract, point] of [
  ['conversation.completion-start', 'established'],
  ['conversation.completion-reply', 'waiting'],
  ['conversation.completion-reply', 'completed'],
  ['conversation.interaction-completion', 'completed'],
  ['conversation.material-answer', 'completed'],
]) {
  test(`model recovery at ${contract}/${point} consumes the fixed feedback without sending or preview replay`, async () => {
    const store = new Journal();
    const saved = persistence();
    let sends = 0;
    const original = modelHarness(store, saved, (_request, { publish }) => {
      sends++;
      publish('预览');
      return response;
    });
    const previews = [];
    original.runner.output.subscribe({
      receive(event) {
        if (event.kind === 'delta') previews.push(event.delta);
      },
    });
    assert.equal(await original.runner.run(material), response.text);
    await original.interactions.settled();
    original.interactions.close();
    assert.deepEqual(previews, ['预览']);
    const boundary = store.writes.findIndex((write) => write.image?.contract.key === contract && write.image.point === point);
    assert.ok(boundary >= 0);
    const restored = modelHarness(prefix(store.writes, boundary), saved, () => assert.fail('recovery cannot send'));
    const replay = [];
    restored.runner.output.subscribe({
      receive(event) {
        if (event.kind === 'delta') replay.push(event.delta);
      },
    });
    assert.equal(await restored.runner.resume(store.writes[0].image.frame.owner.contextId), response.text);
    assert.deepEqual(replay, []);
    assert.equal(sends, 1);
    await restored.interactions.settled();
    restored.interactions.close();
  });
}

for (const point of ['sending', 'reading'])
  test(`a child at ${point} without its first checkpoint is unknown and never retried`, async () => {
    const store = new Journal();
    const saved = persistence();
    const original = modelHarness(store, saved, () => response);
    await original.runner.run(material);
    await original.interactions.settled();
    original.interactions.close();
    const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'conversation.interaction-completion' && write.image.point === point);
    const restored = modelHarness(prefix(store.writes, boundary), saved, () => assert.fail('unknown delivery cannot resend'));
    await assert.rejects(restored.runner.resume(store.writes[0].image.frame.owner.contextId), /no durable continuation/);
    restored.interactions.close();
  });

test('an established reference without saved external feedback cannot resume by resending', async () => {
  const store = new Journal();
  const saved = persistence();
  const original = modelHarness(store, saved, () => response);
  await original.runner.run(material);
  await original.interactions.settled();
  original.interactions.close();
  for (const [id, state] of saved.values) saved.values.set(id, { id, contract: state.contract, request: state.request, revision: 1, delivery: 'started' });
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'conversation.completion-start' && write.image.point === 'established');
  const restored = modelHarness(prefix(store.writes, boundary), saved, () => assert.fail('a missing response cannot trigger resend'));
  await assert.rejects(restored.runner.resume(store.writes[0].image.frame.owner.contextId), { code: 'INTERACTION_RESTORED_PENDING' });
  restored.interactions.close();
});

test('restoration still rejects a saved incomplete model reply at the answer boundary', async () => {
  const store = new Journal();
  const saved = persistence();
  let sends = 0;
  const original = modelHarness(store, saved, () => {
    sends++;
    return { ...response, finishReason: 'length' };
  });
  await assert.rejects(original.runner.run(material), { code: 'MODEL_OUTPUT_LIMIT' });
  await original.interactions.settled();
  original.interactions.close();
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'conversation.completion-reply' && write.image.point === 'waiting');
  const restored = modelHarness(prefix(store.writes, boundary), saved, () => assert.fail('business rejection cannot restart the model'));
  await assert.rejects(restored.runner.resume(store.writes[0].image.frame.owner.contextId), { code: 'MODEL_OUTPUT_LIMIT' });
  assert.equal(sends, 1);
  restored.interactions.close();
});

test('a direct model call can restore its saved completion but never repeats the provider operation', async () => {
  const store = new Journal();
  const firstResources = new Resources().register(new Resource({ complete: async () => response }), CompletionResource);
  const first = new Runner(fixtureScene(createMaterialAnswer(createCompletionNode())), firstResources, undefined, { checkpoints: { store } }).build();
  assert.equal(await first.run(material), response.text);
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'conversation.direct-completion');
  const restoredResources = new Resources().register(new Resource({ complete: () => assert.fail('completed direct request cannot repeat') }), CompletionResource);
  const restored = new Runner(fixtureScene(createMaterialAnswer(createCompletionNode())), restoredResources, undefined, { checkpoints: { store: prefix(store.writes, boundary) } }).build();
  assert.equal(await restored.resume(store.writes[0].image.frame.owner.contextId), response.text);
});

test('saved preparation resumes its fixed material without consulting a changed view', async () => {
  const transcript = new Transcript([
    { role: 'assistant', content: '原材料' },
    { role: 'user', content: '问题' },
  ]);
  const memories = new Memories(transcript);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [{ source: 'messages', key: 0 }] });
  const store = new Journal();
  const resources = new Resources().register(new Resource({ transcript, memories, view }), ConversationViewResource.read);
  const first = new Runner(fixtureScene(createMaterialPreparation()), resources, undefined, { checkpoints: { store } }).build();
  const input = { transcriptId: transcript.id, index: 1, message: transcript.get(1) };
  const fixed = await first.run(input);
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'conversation.material-preparation');
  const later = new Transcript([{ role: 'assistant', content: '不相关的新材料' }]);
  const laterMemories = new Memories(later);
  const laterView = new View({ revision: 0, sources: { messages: { id: later.id, scope: 'whole' }, memories: { id: laterMemories.id, scope: 'whole' } }, members: [] });
  const replacement = new Resources().register(new Resource({ transcript: later, memories: laterMemories, view: laterView }), ConversationViewResource.read);
  const restored = new Runner(fixtureScene(createMaterialPreparation()), replacement, undefined, { checkpoints: { store: prefix(store.writes, boundary) } }).build();
  assert.deepEqual(await restored.resume(store.writes[0].image.frame.owner.contextId), fixed);
  assert.equal(fixed.materials.entries[0].value.content, '原材料');
});

test('material checkpoint schema refuses invented indexes, identities, duplicates and extra fields', () => {
  const contract = createMaterialAnswer().checkpoint.input;
  assert.deepEqual(contract.decode(contract.encode(material)), material);
  for (const mutate of [
    (value) => {
      value.query.transcriptId = 'another';
    },
    (value) => {
      value.materials.entries[0].key = value.query.index;
    },
    (value) => {
      value.materials.entries.push(value.materials.entries[0]);
    },
    (value) => {
      value.materials.basis.sources.messages.extra = true;
    },
    (value) => {
      value.materials.entries.push({ source: 'memories', key: 'm', value: { id: 'm', topic: '偏好', content: '中文', sourceIndexes: [] } });
    },
    (value) => {
      value.materials.entries.push({ source: 'memories', key: 'm', value: { id: 'other', topic: '偏好', content: '中文', sourceIndexes: [0] } });
    },
  ]) {
    const invalid = structuredClone(material);
    mutate(invalid);
    assert.throws(() => contract.decode(invalid));
  }
});

test('material request identity survives input field order changes at checkpoint encoding', async () => {
  const reordered = { materials: { entries: material.materials.entries, basis: material.materials.basis }, query: { content: material.query.content, index: material.query.index, transcriptId: material.query.transcriptId } };
  const store = new Journal();
  const saved = persistence();
  const original = modelHarness(store, saved, () => response);
  assert.equal(await original.runner.run(reordered), response.text);
  await original.interactions.settled();
  original.interactions.close();
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'conversation.completion-reply' && write.image.point === 'waiting');
  const restored = modelHarness(prefix(store.writes, boundary), saved, () => assert.fail('request field ordering cannot trigger another send'));
  assert.equal(await restored.runner.resume(store.writes[0].image.frame.owner.contextId), response.text);
  restored.interactions.close();
});
