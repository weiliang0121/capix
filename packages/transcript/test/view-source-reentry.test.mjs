import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';

const changed = (error) => error instanceof RuntimeError && error.code === 'VIEW_SOURCE_CONFLICT';

function keyWithGetter(read) {
  const keys = [];
  Object.defineProperty(keys, '0', { enumerable: true, get: read });
  keys.length = 1;
  return keys;
}

test('inspection cannot use a new source version introduced by reading requested keys', () => {
  const transcript = new Transcript([{ role: 'user', content: 'original' }]);
  const messages = new TranscriptViewSource(transcript);
  const messageKeys = keyWithGetter(() => {
    transcript.append({ role: 'assistant', content: 'appended while inspecting' });
    return 0;
  });
  assert.throws(() => messages.inspect(messageKeys), changed);
});
