import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { Memories } from '@weiliang0121/capix-memory';
import { create } from './support.mjs';

test('invalid synchronous persistence acknowledgements make the instance uncertain without publishing', async () => {
  for (const returned of [null, true, 1, Promise.resolve(), Promise.reject(new Error('late storage error'))]) {
    let writes = 0;
    let published = 0;
    const memories = new Memories({
      persistence: {
        commit() {
          writes++;
          return returned;
        },
      },
      changes: {
        capture() {
          published++;
        },
      },
    });
    assert.throws(() => memories.apply([create('candidate')]), PersistenceError);
    assert.throws(() => memories.snapshot(), PersistenceError);
    assert.throws(() => memories.apply([]), PersistenceError);
    assert.equal(writes, 1);
    assert.equal(published, 0);
  }
  await new Promise((resolve) => setImmediate(resolve));
});
