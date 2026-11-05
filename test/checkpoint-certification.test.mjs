import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloneCheckpointImage, cloneCheckpointDelivery, cloneCheckpointHead, cloneCheckpointValue, checkpointSaveReceipt, checkpointFinishReceipt, checkCheckpointSaveReceipt, checkCheckpointFinishReceipt } from '@capix/checkpoint';

function image() {
  return { id: 'image', formatVersion: 5, contract: { key: 'fixture', version: 1 }, point: 'saved', frame: { owner: { contextId: 'call', kind: 'node' }, round: 1, phase: 'execute', input: { text: 'original' }, currentInput: null, nextChildOrder: 0, children: [] }, state: { value: 'fixed' }, references: {} };
}

test('whole-image certification is reusable only for the exact deeply fixed object', () => {
  const raw = image();
  const fixed = cloneCheckpointImage(raw);
  assert.notEqual(fixed, raw);
  assert.equal(cloneCheckpointImage(fixed), fixed);
  assert.equal(cloneCheckpointHead({ revision: 1, image: fixed }).image, fixed);
  raw.state.value = 'changed';
  assert.equal(fixed.state.value, 'fixed');
  assert.throws(() => {
    fixed.frame.input.text = 'changed';
  }, TypeError);
  const thawed = JSON.parse(JSON.stringify(fixed));
  const imported = cloneCheckpointImage(thawed);
  assert.notEqual(imported, thawed);
  assert.notEqual(imported, fixed);
  assert.deepEqual(imported, fixed);
  assert.notEqual(cloneCheckpointImage(raw), cloneCheckpointImage(raw), 'mutable inputs never acquire a cached proof');
});

test('freezing, pure-value certification and copying an image do not forge image proof', () => {
  const invalid = image();
  invalid.frame.owner.kind = 'invalid';
  assert.throws(() => cloneCheckpointImage(cloneCheckpointValue(invalid)), /invalid frame/);
  const shallow = Object.freeze(image());
  const fixed = cloneCheckpointImage(shallow);
  shallow.state.value = 'mutated';
  assert.equal(fixed.state.value, 'fixed');
  const copied = { ...fixed, references: { absent: { contextId: 'missing' } } };
  assert.throws(() => cloneCheckpointImage(copied), /reference/);
  let called = false;
  const getter = { ...fixed };
  Object.defineProperty(getter, 'state', {
    enumerable: true,
    get() {
      called = true;
      return {};
    },
  });
  assert.throws(() => cloneCheckpointImage(getter), /accessor/);
  assert.equal(called, false);
});

test('certified whole images cannot bypass aggregate budgets when inserted in a new image', () => {
  const part = cloneCheckpointImage({ ...image(), state: 'x'.repeat(5 * 1024 * 1024) });
  assert.throws(() => cloneCheckpointImage({ ...image(), state: [part, part] }), /byte limit/);
});

test('delivery certification is separate and write receipts bind the exact encoded content', () => {
  const fixed = cloneCheckpointImage(image());
  const receipt = checkpointSaveReceipt(fixed, 1);
  assert.deepEqual(checkCheckpointSaveReceipt(receipt, fixed, 0), receipt);
  assert.equal('image' in receipt, false);
  const other = cloneCheckpointImage({ ...fixed, state: { value: 'same identity, different body' } });
  assert.throws(() => checkCheckpointSaveReceipt(checkpointSaveReceipt(other, 1), fixed, 0), /digest/);
  const delivery = cloneCheckpointDelivery({ status: 'succeeded', output: { answer: 'one' }, progress: { round: 1, phase: 'execute', currentInput: null } });
  assert.equal(cloneCheckpointDelivery(delivery), delivery);
  const finished = checkpointFinishReceipt('call', 'image', delivery, 2);
  assert.deepEqual(checkCheckpointFinishReceipt(finished, 'call', 'image', delivery, 1), finished);
  assert.equal('delivery' in finished, false);
  assert.throws(() => checkCheckpointFinishReceipt(checkpointFinishReceipt('call', 'image', { ...delivery, output: { answer: 'two' } }, 2), 'call', 'image', delivery, 1), /digest/);
  assert.throws(() => checkCheckpointFinishReceipt(checkpointFinishReceipt('call', 'image', { status: 'failed' }, 2), 'call', 'image', delivery, 1), /status/);
});

test('receipt admission rejects foreign progress and accessors without invoking them', () => {
  const fixed = cloneCheckpointImage(image());
  const receipt = checkpointSaveReceipt(fixed, 1);
  for (const wrong of [
    { ...receipt, contextId: 'another' },
    { ...receipt, checkpointId: 'another' },
    { ...receipt, revision: 99 },
    { ...receipt, kind: 'finished' },
    { ...receipt, extra: true },
    { ...receipt, [Symbol('hidden')]: true },
  ]) {
    assert.throws(() => checkCheckpointSaveReceipt(wrong, fixed, 0), /receipt/);
  }
  let read = false;
  const wrong = { ...receipt };
  Object.defineProperty(wrong, 'revision', {
    enumerable: true,
    get() {
      read = true;
      return 1;
    },
  });
  assert.throws(() => checkCheckpointSaveReceipt(wrong, fixed, 0), /receipt/);
  assert.equal(read, false);
  for (const identity of [undefined, null, 1, {}, '']) {
    assert.throws(() => checkpointFinishReceipt(identity, 'image', { status: 'failed' }, 2), /identity/);
    assert.throws(() => checkpointFinishReceipt('call', identity, { status: 'failed' }, 2), /identity/);
  }
});
