import assert from 'node:assert/strict';

import { test } from 'node:test';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

const codec = { encode: (value) => value, decode: (value) => value };

function countedStore() {
  const store = new MemoryCheckpointStore();
  const counts = { saves: 0, finishes: 0 };
  return {
    store,
    counts,
    port: {
      read: (id) => store.read(id),
      save(image, revision) {
        counts.saves++;
        return store.save(image, revision);
      },
      finish(id, revision, delivery) {
        counts.finishes++;
        return store.finish(id, revision, delivery);
      },
    },
  };
}

test('low-level checkpoint checks also reject thenables before calling Store', async () => {
  const { port, counts } = countedStore();
  const context = new InvocationContext(null);
  const call = new Invocation({
    context,
    signal: new AbortController().signal,
    identity: { contextId: context.id, kind: 'node' },
    checkpoints: { store: port },
    work: {
      checkpoint: {
        key: 'test.low-level-synchronous-check',
        version: 1,
        input: codec,
        output: codec,
        points: { ready: { state: codec, check: async () => undefined, execute: () => assert.fail('not restoring') } },
      },
      execute(_context, invocation) {
        invocation.checkpointWriter.save('ready', null);
        return 'unreachable';
      },
    },
  });
  await assert.rejects(call.run(), /synchron|thenable|asynchron/i);
  assert.deepEqual(counts, { saves: 0, finishes: 0 });
});
