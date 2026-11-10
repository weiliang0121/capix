import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';

const conflict = (error) => error instanceof RuntimeError && error.code === 'VIEW_SOURCE_CONFLICT';

test('Transcript source enforces its fixed scope and version', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'Original request' },
    { role: 'assistant', content: 'Original answer' },
  ]);
  const messages = new TranscriptViewSource(transcript, [0]);
  const indexed = messages.index();
  assert.deepEqual(indexed.entries, [{ key: 0, summary: { role: 'user' } }]);
  assert.throws(() => messages.read([1], indexed.stamp), RangeError);
  assert.throws(() => messages.read([0, 0], indexed.stamp), TypeError);
  transcript.append({ role: 'user', content: 'later' });
  assert.equal(messages.check(indexed.stamp), false);
  assert.throws(() => messages.read([0], indexed.stamp), conflict);
  assert.deepEqual(
    messages.index().entries.map((entry) => entry.key),
    [0],
    'later appends do not enlarge a fixed source scope',
  );
});
