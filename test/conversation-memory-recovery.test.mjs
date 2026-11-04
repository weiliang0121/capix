import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloneCheckpointImage, cloneCheckpointDelivery } from '@capix/checkpoint';
import { CompletionResource, ConversationMemoryResource, ConversationViewResource, createMemoryMaintenance, createMessageInclusion } from '@capix/conversation-service';
import { Memories, MemoryResource } from '@capix/memory';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Scene, childReference, checkpointPoint } from '@capix/structure';
import { Transcript } from '@capix/transcript';
import { View } from '@capix/view';

const valueCodec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const voidCodec = { encode: () => null, decode: () => undefined };
const create = (content) => ({ action: 'create', memoryId: null, change: 'remember preference', sourceIndexes: [0], result: { topic: 'Preference', content, sourceIndexes: [0] } });

class SavedHeads {
  constructor(heads = []) {
    this.heads = new Map(structuredClone(heads));
  }
  read(id) {
    return this.heads.get(id);
  }
  save(image, revision) {
    this.beforeSave?.(image);
    assert.equal(this.read(image.frame.owner.contextId)?.revision ?? 0, revision);
    const head = { revision: revision + 1, image: cloneCheckpointImage(image) };
    this.heads.set(image.frame.owner.contextId, head);
    this.afterSave?.(image);
    return head;
  }
  finish(id, revision, delivery) {
    const previous = this.read(id);
    assert.equal(previous.revision, revision);
    const head = { ...previous, revision: revision + 1, delivery: cloneCheckpointDelivery(delivery) };
    this.heads.set(id, head);
    return head;
  }
}

function content(saved) {
  const transcript = saved
    ? Transcript.restore(saved.transcript)
    : new Transcript([
        { role: 'user', content: 'Be concise' },
        { role: 'assistant', content: 'Understood' },
      ]);
  const memories = saved ? Memories.restore(saved.memories, transcript) : new Memories(transcript);
  const view = new View(saved?.view ?? { revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
  return { transcript, memories, view };
}

function setup(state, store, { fail = false, forbidModel = false, include = false } = {}) {
  let calls = 0;
  const model = {
    async complete() {
      calls++;
      if (forbidModel) throw new Error('A restored accepted proposal must not call the model');
      if (fail) throw new Error('No valid extraction');
      return { id: 'model', model: 'fixture', text: JSON.stringify({ changes: [create('Concise')] }), finishReason: 'stop', usage: null };
    },
  };
  const maintenance = include ? createMessageInclusion() : createMemoryMaintenance();
  const waiting = checkpointPoint()({ name: 'waiting', state: voidCodec, references: { maintenance: childReference(maintenance) }, resume: { uses: [maintenance], run: (work, _state, refs) => work.children.resume(refs.maintenance).invoke() } });
  const scene = new Scene({
    checkpoint: { key: 'test.memory.root', version: 1, input: valueCodec, output: voidCodec, points: [waiting] },
    run(work) {
      const call = work.children.create(maintenance, work.input, { key: 'maintenance' });
      work.checkpoint({ point: waiting, state: undefined, refs: { maintenance: call.ref } });
      return call.invoke();
    },
  }).add(maintenance);
  const resources = new Resources().register(new Resource(state.memories), ConversationMemoryResource).register(new Resource(state.memories), MemoryResource.apply).register(new Resource(state), ConversationViewResource.manage).register(new Resource(model), CompletionResource);
  return { runner: new Runner(scene, resources, undefined, { checkpoints: { store } }).build(), calls: () => calls };
}

async function capture(at, options = {}) {
  const state = content();
  if (options.initialMemory) state.memories.apply([create('Existing inactive memory')]);
  const store = new SavedHeads();
  let saved;
  const take = (image) => {
    if (saved || !at(image)) return;
    saved = structuredClone({ heads: [...store.heads], transcript: state.transcript.exportState(), memories: state.memories.exportState(), view: state.view.exportState() });
  };
  store[options.after ? 'afterSave' : 'beforeSave'] = take;
  const initial = setup(state, store, options);
  await initial.runner.run({ transcriptId: state.transcript.id, index: 1, message: state.transcript.get(1) });
  assert.ok(saved, 'the selected actual open checkpoint boundary was reached');
  const root = saved.heads.find(([, head]) => head.image.contract.key === 'test.memory.root');
  assert.equal(root[1].delivery, undefined, 'snapshot is an interrupted call, not a caught terminal failure');
  return { saved, contextId: root[0], calls: initial.calls() };
}

test('memory recovery confirms an already applied fixed batch and includes the original new IDs without re-extraction', async () => {
  const { saved, contextId, calls } = await capture((image) => image.contract.key === 'conversation.memory.apply' && image.point === 'completed');
  assert.equal(calls, 1);
  assert.equal(saved.memories.items.length, 1);
  assert.equal(saved.memories.applies.length, 1);
  assert.deepEqual(saved.view.members, []);
  const state = content(saved);
  const store = new SavedHeads(saved.heads);
  const restored = setup(state, store, { forbidModel: true });
  await restored.runner.resume(contextId);
  assert.equal(restored.calls(), 0);
  assert.deepEqual(state.memories.exportState(), saved.memories);
  assert.deepEqual(state.view.members(), [{ source: 'memories', key: saved.memories.items[0].id }]);
});

test('accepted extraction resumes its original proposal and basis before the fixed write', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.maintenance' && image.point === 'proposalReceived', { after: true });
  assert.deepEqual(saved.memories.items, []);
  const state = content(saved);
  const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
  await restored.runner.resume(contextId);
  assert.equal(restored.calls(), 0);
  assert.equal(state.memories.values().length, 1);
  assert.equal(state.memories.values()[0].content, 'Concise');
  assert.equal(state.view.members()[0].key, state.memories.values()[0].id);
});

test('a handled failed proposal resumes skipped without converting it into an empty application', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.maintenance' && image.point === 'proposalReceived', { after: true, fail: true });
  const head = saved.heads.find(([, head]) => head.image.contract.key === 'conversation.memory.maintenance')[1];
  assert.equal(head.image.frame.children[0].state.kind, 'failed');
  const state = content(saved);
  const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
  await restored.runner.resume(contextId);
  assert.equal(restored.calls(), 0);
  assert.deepEqual(state.memories.exportState(), saved.memories);
  assert.deepEqual(state.view.members(), []);
});

test('recovery after View inclusion uses ensure-members without a second member change or memory batch', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.maintenance' && image.point === 'completed');
  assert.equal(saved.view.members.length, 1);
  const state = content(saved);
  const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
  await restored.runner.resume(contextId);
  assert.equal(restored.calls(), 0);
  assert.deepEqual(state.memories.exportState(), saved.memories);
  assert.deepEqual(state.view.exportState(), saved.view);
});

test('message inclusion recovers its exact saved member after the View effect and before its checkpoint', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.message.include' && image.point === 'completed', { include: true });
  const state = content(saved);
  const restored = setup(state, new SavedHeads(saved.heads), { include: true });
  await restored.runner.resume(contextId);
  assert.deepEqual(state.view.exportState(), saved.view);
  assert.deepEqual(state.view.members(), [{ source: 'messages', key: 1 }]);
});

test('resuming a fixed proposal against a changed memory basis rejects before applying it', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.maintenance' && image.point === 'proposalReceived', { after: true });
  const state = content(saved);
  state.memories.apply([create('external change')]);
  const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
  await assert.rejects(restored.runner.resume(contextId), { code: 'MEMORY_BASIS_CONFLICT' });
  assert.equal(restored.calls(), 0);
  assert.equal(state.memories.values().length, 1);
  assert.equal(state.memories.values()[0].content, 'external change');
  assert.deepEqual(state.view.members(), []);
});

test('recovery keeps the original memory IDs even when an existing inactive memory precedes the new effect', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.apply' && image.point === 'completed', { initialMemory: true });
  assert.equal(saved.memories.items.length, 2);
  const state = content(saved);
  const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
  await restored.runner.resume(contextId);
  assert.equal(restored.calls(), 0);
  assert.deepEqual(state.memories.exportState(), saved.memories);
  assert.deepEqual(state.view.members(), [{ source: 'memories', key: saved.memories.items[1].id }]);
});

test('a changed saved extraction context cannot be substituted for the accepted proposal input', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.maintenance' && image.point === 'proposalReceived', { after: true });
  const head = saved.heads.find(([, head]) => head.image.contract.key === 'conversation.memory.maintenance')[1];
  head.image.state.messages[0].message.content = 'Different evidence';
  const state = content(saved);
  const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
  await assert.rejects(restored.runner.resume(contextId), /original extraction context/);
  assert.equal(restored.calls(), 0);
  assert.deepEqual(state.memories.snapshot(), []);
});

test('an unfinished direct completion without saved feedback is unavailable and is never reissued during recovery', async () => {
  const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.proposal' && image.point === 'completionWaiting', { after: true });
  const state = content(saved);
  const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
  await assert.rejects(restored.runner.resume(contextId));
  assert.equal(restored.calls(), 0);
  assert.deepEqual(state.memories.snapshot(), []);
  assert.deepEqual(state.view.members(), []);
});

test('a saved application cannot replace the original existing IDs or accepted changes', async (t) => {
  for (const field of ['existingIds', 'changes'])
    await t.test(field, async () => {
      const { saved, contextId } = await capture((image) => image.contract.key === 'conversation.memory.apply' && image.point === 'prepared', { after: true });
      const parent = saved.heads.find(([, head]) => head.image.contract.key === 'conversation.memory.maintenance')[1];
      const child = parent.image.frame.children.find((child) => child.key === 'apply');
      if (field === 'existingIds') child.input.existingIds = ['unrelated-memory'];
      else child.input.changes[0].result.content = 'Unaccepted replacement';
      const state = content(saved);
      const restored = setup(state, new SavedHeads(saved.heads), { forbidModel: true });
      await assert.rejects(restored.runner.resume(contextId));
      assert.equal(restored.calls(), 0);
      assert.deepEqual(state.memories.snapshot(), []);
    });
});
