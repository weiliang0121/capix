import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Memories } from '@weiliang0121/capix-memory';
import { create, update } from './support.mjs';

test('independent collections own UUIDs and immutable items without a Transcript', () => {
  const first = new Memories();
  const second = new Memories();
  assert.notEqual(first.id, second.id);
  const a = first.apply([create('same'), create('same')]);
  assert.equal(a.before.sequence, 0);
  assert.equal(a.after.sequence, 2);
  assert.notEqual(a.changed[0].id, a.changed[1].id);
  assert.match(a.changed[0].id, /^[0-9a-f-]{36}$/i);
  const old = first.read(a.changed[0].id);
  const changed = first.apply([update(old.id, 'new')], { expected: old.basis });
  assert.equal(changed.changed[0].id, old.id);
  assert.equal(old.value.content, 'same');
  assert.equal(first.read(old.id).value.content, 'new');
  assert.equal(first.sequence, 3);
  assert.equal(second.sequence, 0);
  assert.equal(first.read('missing'), undefined);
  assert.deepEqual(
    first.values().map((item) => item.id),
    a.changed.map((item) => item.id),
  );
  assert.deepEqual(first.apply([]).changed, []);
  assert.deepEqual(first.apply([update(old.id, 'new')]).changed, []);
  assert.equal(first.sequence, 3);
  assert.throws(() => {
    old.value.content = 'mutate';
  }, TypeError);
});
