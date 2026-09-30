import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordBook, RecordIndex, BaseRecord } from '@capix-observer/runtime';

test('Selectors index the same records by different keys without changing Book', () => {
  const book = new RecordBook();
  const byGroup = new RecordIndex((record) => record.value.group);
  const byLabel = new RecordIndex((record) => record.value.label);
  const a = book.add(new BaseRecord({ group: 'g1', label: 'x' }));
  const b = book.add(new BaseRecord({ group: 'g1', label: 'y' }));
  const c = book.add(new BaseRecord({ group: 'g2', label: 'x' }));
  for (const record of book.values()) {
    byGroup.add(record);
    byLabel.add(record);
  }
  assert.deepEqual(byGroup.get('g1'), [a.id, b.id]);
  assert.deepEqual(byLabel.get('x'), [a.id, c.id]);
  assert.deepEqual(
    byLabel.get('x').map((id) => book.get(id)),
    [a, c],
  );
  assert.deepEqual(byGroup.get('missing'), []);
  const detached = byGroup.get('g1');
  detached.length = 0;
  assert.deepEqual(byGroup.get('g1'), [a.id, b.id]);
  assert.equal(book.get(a.id), a);
  assert.equal(byGroup.remove(a.id), true);
  assert.deepEqual(byGroup.get('g1'), [b.id]);
  assert.deepEqual(byLabel.get('x'), [a.id, c.id]);
  assert.equal(book.get(a.id), a);
});

test('Explicit reindexing moves membership; remove uses the previously indexed key', () => {
  const record = new BaseRecord({ key: '' });
  const index = new RecordIndex((item) => item.value.key);
  index.add(record);
  index.add(record);
  assert.deepEqual(index.get(''), [record.id]);
  record.value.key = 'next';
  assert.deepEqual(index.get(''), [record.id]); // No automatic observation.
  assert.deepEqual(index.get('next'), []);
  index.add(record);
  assert.deepEqual(index.get(''), []);
  assert.deepEqual(index.get('next'), [record.id]);
  record.value.key = 'not-indexed';
  assert.equal(index.remove(record.id), true);
  assert.deepEqual(index.get('next'), []);
  assert.deepEqual(index.get('not-indexed'), []);
  assert.equal(index.remove(record.id), false);
  index.add(record);
  assert.deepEqual(index.get('not-indexed'), [record.id]);
});

test('A failed selector preserves existing memberships', () => {
  const failure = new Error('selector failed');
  const index = new RecordIndex((record) => {
    if (record.value.key === 'invalid') throw failure;
    return record.value.key;
  });
  const record = new BaseRecord({ key: 'original' });
  index.add(record);
  record.value.key = 'invalid';
  assert.throws(
    () => index.add(record),
    (error) => error === failure,
  );
  assert.deepEqual(index.get('original'), [record.id]);
  assert.deepEqual(index.get('invalid'), []);
  assert.equal(index.remove(record.id), true);
  assert.deepEqual(index.get('original'), []);
});
