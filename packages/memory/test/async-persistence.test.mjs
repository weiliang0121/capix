import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChangeBuffer } from '@weiliang0121/capix-changes';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { Memories } from '@weiliang0121/capix-memory';

import { Transcript } from '@weiliang0121/capix-transcript';

const message = (content, role = 'user') => ({ role, content });

const create = (content, indexes = [0]) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: indexes, result: { topic: 'topic', content, sourceIndexes: indexes } });

test('accidentally asynchronous persistence never publishes or mutates content', async () => {
  const changes = new ChangeBuffer();
  const memories = new Memories(new Transcript([message('input')]), {
    changes,
    persistence: {
      async commit() {
        throw new Error('async failure');
      },
    },
  });
  assert.throws(
    () => memories.apply([create('one')]),
    (error) => error instanceof PersistenceError && error.operation === 'memories.commit' && error.cause instanceof TypeError && /synchronously/.test(error.cause.message),
  );
  assert.equal(memories.values().length, 0);
  assert.equal(memories.sequence, 0);
  assert.equal(changes.size, 0);
  await Promise.resolve();
});
