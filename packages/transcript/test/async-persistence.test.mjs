import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChangeBuffer } from '@weiliang0121/capix-changes';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { Transcript } from '@weiliang0121/capix-transcript';

const message = (content, role = 'user') => ({ role, content });

test('accidentally asynchronous persistence never publishes or mutates content', async () => {
  const changes = new ChangeBuffer();
  const transcript = new Transcript([], {
    changes,
    persistence: {
      async commit() {
        throw new Error('async failure');
      },
    },
  });
  assert.throws(
    () => transcript.append(message('input')),
    (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause instanceof TypeError && /synchronously/.test(error.cause.message),
  );
  assert.equal(transcript.length, 0);
  assert.equal(transcript.revision, 0);
  assert.equal(changes.size, 0);
  await Promise.resolve();
});
