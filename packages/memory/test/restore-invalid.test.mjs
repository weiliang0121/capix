import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Memories } from '@weiliang0121/capix-memory';
import { create, update, fixed } from './support.mjs';

test('restore rejects old formats, malformed content and impossible request/receipt correspondences without writing', () => {
  let writes = 0;
  const options = {
    persistence: {
      commit() {
        writes++;
      },
    },
  };
  const memories = new Memories();
  const request = fixed(memories, [create('one'), create('two')]);
  memories.applyFixed(request);
  const saved = memories.exportState();
  const invalid = [
    { ...saved, version: 1 },
    { ...saved, version: undefined },
    { ...saved, id: 'not-uuid' },
    { ...saved, sequence: 0 },
    { ...saved, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...saved, transcriptId: 'legacy' },
    { ...saved, items: [saved.items[0], saved.items[0]] },
    { ...saved, items: [{ ...saved.items[0], value: { content: '' } }, saved.items[1]] },
  ];
  const tamper = (edit) => {
    const state = structuredClone(saved);
    edit(state.applies[0]);
    invalid.push(state);
  };
  tamper((entry) => {
    entry.request.command.changes = [];
  });
  tamper((entry) => {
    entry.receipt.changes = [];
  });
  tamper((entry) => {
    entry.receipt.changes[0].commandIndex = 2;
  });
  tamper((entry) => {
    entry.receipt.changes[1].commandIndex = 0;
  });
  tamper((entry) => {
    entry.receipt.changes[1].memoryId = entry.receipt.changes[0].memoryId;
  });
  tamper((entry) => {
    entry.receipt.memoriesId = 'foreign';
  });
  tamper((entry) => {
    entry.request.command.changes[0] = update(saved.items[1].id, 'wrong target');
  });
  tamper((entry) => {
    entry.request.expected = { memoriesId: saved.id, sequence: 1 };
  });
  for (const state of invalid) assert.throws(() => Memories.restore(state, options));
  assert.equal(writes, 0);
});

test('old receipt validation does not compare against subsequently changed current content', () => {
  const memories = new Memories();
  const id = memories.apply([create('original')]).changed[0].id;
  const request = fixed(memories, [update(id, 'fixed')]);
  const receipt = memories.applyFixed(request);
  memories.apply([update(id, 'subsequent')]);
  const restored = Memories.restore(memories.exportState());
  assert.deepEqual(restored.confirmFixed(request), receipt);
  assert.equal(restored.read(id).value.content, 'subsequent');
});

test('exhausted sequence rejects before persistence or ID installation', () => {
  const first = new Memories();
  first.apply([create('base')]);
  let writes = 0;
  const memories = Memories.restore(
    { ...first.exportState(), sequence: Number.MAX_SAFE_INTEGER },
    {
      persistence: {
        commit() {
          writes++;
        },
      },
    },
  );
  assert.throws(() => memories.apply([create('overflow')]), RangeError);
  assert.equal(writes, 0);
  assert.equal(memories.values().length, 1);
});
