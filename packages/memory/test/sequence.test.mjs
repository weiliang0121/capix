import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Memories } from '@weiliang0121/capix-memory';

import { Transcript } from '@weiliang0121/capix-transcript';

const create = (text) => ({ action: 'create', memoryId: null, change: 'create', sourceIndexes: [0], result: { topic: 'topic', content: text, sourceIndexes: [0] } });

const transcript = () => new Transcript([{ role: 'user', content: 'input' }]);

test('Memories order exists without recording, and separate collections have separate scopes', () => {
  const source = transcript();
  const first = new Memories(source);
  const second = new Memories(source);
  first.apply([create('one'), create('two')]);
  second.apply([create('other')]);
  assert.equal(first.sequence, 2);
  assert.equal(second.sequence, 1);
  assert.notEqual(first.id, second.id);
});
