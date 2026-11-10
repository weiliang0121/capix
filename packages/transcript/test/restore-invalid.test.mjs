import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Transcript } from '@weiliang0121/capix-transcript';

const message = (content, role = 'user') => ({ role, content });

test('restoration rejects broken identities, positions and sources without submitting persistence writes', () => {
  const transcript = new Transcript([message('input'), message('answer', 'assistant')]);
  const base = transcript.exportState();
  let writes = 0;
  const persistence = {
    commit() {
      writes++;
    },
  };
  for (const state of [
    { ...base, id: '' },
    { ...base, starts: [] },
    { ...base, starts: [1] },
    { ...base, starts: [0, 0] },
    { ...base, starts: [0, 2] },
    { ...base, revision: 0 },
    { ...base, revision: 3 },
    { ...base, messages: [message('good'), undefined] },
  ])
    assert.throws(() => Transcript.restore(state, { persistence }));
  assert.equal(writes, 0);
});
