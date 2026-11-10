import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Memories } from '@weiliang0121/capix-memory';

import { Transcript } from '@weiliang0121/capix-transcript';

const message = (content, role = 'user') => ({ role, content });

const create = (content, indexes = [0]) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: indexes, result: { topic: 'topic', content, sourceIndexes: indexes } });

test('restoration rejects broken identities, positions and sources without submitting persistence writes', () => {
  const transcript = new Transcript([message('input'), message('answer', 'assistant')]);
  let writes = 0;
  const persistence = {
    commit() {
      writes++;
    },
  };
  const memories = new Memories(transcript);
  const [memory] = memories.apply([create('understanding')]);
  const saved = memories.exportState();
  for (const state of [
    { ...saved, id: '' },
    { ...saved, transcriptId: 'other' },
    { ...saved, sequence: 0 },
    { ...saved, items: [memory.toJSON(), memory.toJSON()], sequence: 2 },
    { ...saved, items: [{ ...memory.toJSON(), sourceIndexes: [20] }] },
    { ...saved, items: [{ ...memory.toJSON(), sourceResults: [{ id: 'bad-source', kind: 'file-created', answerIndex: 0, receipt: { path: 'x', bytes: 1, digest: 'a'.repeat(64) } }] }] },
  ])
    assert.throws(() => Memories.restore(state, transcript, { persistence }));
  assert.equal(writes, 0);
});
