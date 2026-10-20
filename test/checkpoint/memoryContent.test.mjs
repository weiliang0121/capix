import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript, Memories } from '@capix/server-runtime/content';
import { checkpointTranscriptFingerprint, validateConversationCheckpointContent } from '@capix/observer-service/assembly';

const content = (text) => ({ topic: 'topic', content: text, sourceIndexes: [0] });
const create = (text) => ({ action: 'create', memoryId: null, change: 'create', sourceIndexes: [0], result: content(text) });

function fixture() {
  const transcript = new Transcript([{ role: 'user', content: 'input' }]);
  const memories = new Memories(transcript);
  memories.apply([create('before update'), create('unchanged'), create('unrelated')]);
  const items = memories.snapshot();
  const run = {
    executionContextId: 'execution',
    transcript: { transcriptId: transcript.id, start: 0, end: transcript.length, revision: transcript.revision, fingerprint: checkpointTranscriptFingerprint(transcript, 0, transcript.length) },
    input: { start: 0, end: 1 },
    memories: { id: memories.id, sequence: memories.sequence, items },
  };
  const changes = [{ ...create('after update'), action: 'update', memoryId: items[0].id }, { ...create('unchanged'), action: 'update', memoryId: items[1].id }, create('new memory')];
  const receipt = memories.applyFixed({ contract: { key: 'memories.apply', version: 1 }, operation: { contextId: 'apply', position: 'memories' }, memoriesId: memories.id, changes });
  const identity = { contextId: 'apply', parentContextId: 'execution', kind: 'node' };
  const heads = new Map([
    ['execution', { image: { frame: { children: [{ identity }] } } }],
    ['apply', { image: { contract: { key: 'observer.apply-memory' }, frame: { owner: identity, children: [], input: { memories: changes } } } }],
  ]);
  return { transcript, memories, run, receipt, heads, checkpoints: { read: (id) => heads.get(id) } };
}

test('checkpoint content validates fixed memory creation and update while ignoring no-op sequence allocation', () => {
  const { transcript, memories, run, receipt, checkpoints } = fixture();
  assert.equal(receipt.sequence - receipt.startSequence, 2);
  assert.equal(receipt.memoryIds.length, 2);
  const before = memories.exportState();
  validateConversationCheckpointContent(run, transcript, memories, checkpoints);
  assert.deepEqual(memories.exportState(), before);
  assert.equal(run.memories.items[0].content, 'before update');
});

for (const index of [0, 1, 2, 3]) {
  test(`checkpoint rejects memory content conflict at unchanged sequence, item ${index}`, () => {
    const { transcript, memories, run, checkpoints } = fixture();
    const state = structuredClone(memories.exportState());
    state.items[index].content = 'unrecorded replacement';
    const restored = Memories.restore(state, transcript);
    assert.equal(restored.sequence, memories.sequence);
    assert.deepEqual(restored.exportState().applies, memories.exportState().applies);
    assert.throws(() => validateConversationCheckpointContent(run, transcript, restored, checkpoints), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  });
}

function preparedMaterial(fixture, sequence, values) {
  const { transcript, memories } = fixture;
  return {
    material: { basis: { transcriptId: transcript.id, memoriesId: memories.id, indexRevision: 1, transcriptRevision: transcript.revision, memorySequence: sequence }, messages: [{ index: 0, message: transcript.get(0) }], memories: values },
    context: { message: transcript.get(0), selectedMessages: [] },
    selection: { historyIndexes: [] },
  };
}

test('prepared material keeps its exact old memory version after a confirmed later update', () => {
  const fixtureValue = fixture();
  const { transcript, memories, run, heads, checkpoints } = fixtureValue;
  const prepared = preparedMaterial(fixtureValue, run.memories.sequence, [run.memories.items[0]]);
  heads.get('execution').image.state = { prepared };
  validateConversationCheckpointContent(run, transcript, memories, checkpoints);
  assert.equal(prepared.material.memories[0].content, 'before update');
  prepared.material.memories = [memories.snapshot()[0]];
  assert.throws(() => validateConversationCheckpointContent(run, transcript, memories, checkpoints), { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('prepared material after maintenance requires a confirmed complete memory batch version', () => {
  const fixtureValue = fixture();
  const { transcript, memories, run, heads, checkpoints } = fixtureValue;
  const prepared = preparedMaterial(fixtureValue, memories.sequence, [memories.snapshot()[0]]);
  heads.get('execution').image.state = { prepared };
  validateConversationCheckpointContent(run, transcript, memories, checkpoints);
  prepared.material.basis.memorySequence--;
  assert.throws(() => validateConversationCheckpointContent(run, transcript, memories, checkpoints), { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('a completed preparation is checked before E has accepted or saved its material', () => {
  const fixtureValue = fixture();
  const { transcript, memories, run, heads, checkpoints } = fixtureValue;
  const prepared = preparedMaterial(fixtureValue, run.memories.sequence, []);
  const identity = { contextId: 'prepare', parentContextId: 'execution', kind: 'group' };
  heads.get('execution').image.frame.children.push({ identity });
  heads.set('prepare', { image: { contract: { key: 'observer.prepare-context' }, point: 'completed', state: prepared, frame: { owner: identity, children: [] } } });
  validateConversationCheckpointContent(run, transcript, memories, checkpoints);
  prepared.material.messages[0].message = { role: 'user', content: 'not the accepted input' };
  assert.throws(() => validateConversationCheckpointContent(run, transcript, memories, checkpoints), { code: 'CHECKPOINT_CONTENT_CHANGED' });
});
