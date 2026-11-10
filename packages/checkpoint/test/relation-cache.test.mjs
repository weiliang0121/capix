import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore, createCheckpointValueBlock } from '@weiliang0121/capix-checkpoint';
import { CheckpointRelationCache, encodeCheckpointRecord, prepareCheckpointCommit } from '@weiliang0121/capix-checkpoint/storage';

const reference = ({ id, digest }) => ({ id, digest });
const relationRef = (owner, id = 'child', order = 0) => ({ contextId: id, parentContextId: owner, parentRound: 1, order, target: { position: 0 } });

function initial(owner = 'parent') {
  const input = createCheckpointValueBlock('input', null);
  const output = createCheckpointValueBlock('output', 'original output');
  const state = createCheckpointValueBlock('state', null);
  const refs = createCheckpointValueBlock('refs-initial', {});
  return {
    kind: 'commit',
    formatVersion: 6,
    id: `${owner}-initial`,
    contract: { key: 'relation-cache', version: 1 },
    point: 'saved',
    frame: { owner: { contextId: owner, kind: 'group' }, phase: 'execute', round: 1, input: reference(input), currentInput: reference(input), nextChildOrder: 1 },
    state: reference(state),
    references: reference(refs),
    values: [input, output, state, refs],
    children: [{ identity: { contextId: 'child', parentContextId: owner, kind: 'node' }, target: { position: 0 }, round: 1, order: 0, input: reference(input), state: { kind: 'returned', output: reference(output), progress: { round: 1, currentInput: reference(input), phase: 'execute' }, reception: { kind: 'pending' } } }],
  };
}

function row(owner) {
  const plan = prepareCheckpointCommit(initial(owner), 0, { head: undefined, value() {}, body() {}, child() {}, order() {}, imageUsed: () => false, selection() {}, occurrence() {} });
  return { child_id: 'child', ordinal: 0, body: encodeCheckpointRecord('child', plan.children[0]) };
}

test('bounded relation parsing evidence evicts old rows and never retains a missing row', () => {
  const rows = Object.fromEntries(['one', 'two', 'three'].map((owner) => [owner, row(owner)]));
  const cache = new CheckpointRelationCache({ maxEntries: 2 });
  const one = cache.decode('one', 'child', rows.one);
  assert.equal(cache.decode('one', 'child', { ...rows.one }), one, 'only the exact freshly supplied row reuses its parsed value');
  assert.equal(Object.isFrozen(one.child.state), true);
  cache.decode('two', 'child', rows.two);
  cache.decode('three', 'child', rows.three);
  const again = cache.decode('one', 'child', rows.one);
  assert.notEqual(again, one);
  assert.deepEqual(again, one);
  assert.equal(cache.decode('one', 'child', undefined), undefined);
  const afterMissing = cache.decode('one', 'child', rows.one);
  assert.notEqual(afterMissing, again);
  assert.deepEqual(afterMissing, one);
  assert.throws(() => cache.decode('one', 'child', { ...rows.one, ordinal: 99 }), /identity differs/);
  const afterMismatch = cache.decode('one', 'child', rows.one);
  assert.notEqual(afterMismatch, afterMissing);
  assert.deepEqual(afterMismatch, one);
});

test('relation parsing rejects changed rows and isolates evidence by owner', () => {
  const cache = new CheckpointRelationCache();
  const original = row('one');
  let previous = cache.decode('one', 'child', original);
  for (const changed of [
    { ...original, body: '{}' },
    { ...original, child_id: 'renamed-child' },
    { ...original, ordinal: 7 },
  ]) {
    assert.throws(() => cache.decode('one', 'child', changed));
    const fresh = cache.decode('one', 'child', original);
    assert.notEqual(fresh, previous, 'a rejected current row removes the earlier parsing proof');
    assert.deepEqual(fresh, previous);
    previous = fresh;
  }
  const other = cache.decode('two', 'child', row('two'));
  assert.notEqual(other, previous);
  assert.equal(other.child.identity.parentContextId, 'two');
  assert.equal(previous.child.identity.parentContextId, 'one');
  cache.forget('two');
  assert.equal(cache.decode('one', 'child', original), previous, 'forgetting another owner does not erase this owner');
});

test('byte bounds and explicit lifecycle release discard parsing evidence without changing values', () => {
  const one = row('one');
  const two = row('two');
  const cache = new CheckpointRelationCache({ maxEntries: 10, maxBytes: 64 + 2 * ('one'.length + 'child'.length + one.body.length) });
  const first = cache.decode('one', 'child', one);
  cache.decode('two', 'child', two);
  const second = cache.decode('one', 'child', one);
  assert.notEqual(second, first);
  assert.deepEqual(second, first);
  cache.forget('one');
  const third = cache.decode('one', 'child', one);
  assert.notEqual(third, second);
  cache.clear();
  assert.notEqual(cache.decode('one', 'child', one), third);
  for (const limits of [{ maxBytes: 0 }, { maxEntries: 0 }]) {
    const disabled = new CheckpointRelationCache(limits);
    assert.notEqual(disabled.decode('one', 'child', one), disabled.decode('one', 'child', one));
  }
});

test('Memory Store authenticates repeated references and cannot regress accepted relation facts', () => {
  const store = new MemoryCheckpointStore();
  const base = initial();
  const selected = relationRef('parent');
  let revision = 0;
  let serial = 0;
  const save = ({ children = [], values = [], choices = [selected, selected] } = {}) => {
    const refs = createCheckpointValueBlock(`refs-${++serial}`, { selected: choices });
    const commit = { ...base, id: `save-${serial}`, references: reference(refs), values: [refs, ...values], children };
    const receipt = store.save(commit, revision);
    revision = receipt.revision;
  };
  revision = store.save(base, 0).revision;
  save();
  save();
  const child = base.children[0];
  const receiving = { ...child, state: { ...child.state, reception: { kind: 'receiving', contract: { position: 0 } } } };
  save({ children: [receiving] });
  save();
  assert.equal(store.read('parent').image.frame.children[0].state.reception.kind, 'receiving');
  const output = createCheckpointValueBlock('accepted-output', { kept: true });
  const accepted = { ...child, state: { ...child.state, reception: { kind: 'accepted', contract: { position: 0 }, output: reference(output) } } };
  save({ children: [accepted], values: [output] });
  save();
  const head = store.read('parent');
  assert.equal(head.revision, 7);
  assert.deepEqual(head.image.frame.children[0].state.reception.output, { kept: true });
  assert.deepEqual(head.image.references.selected, [selected, selected]);
  assert.throws(() => save({ children: [receiving] }));
  for (const forged of [
    { ...selected, target: { position: 1 } },
    { ...selected, order: 1 },
    { ...selected, parentContextId: 'another-parent' },
  ]) {
    assert.throws(() => save({ choices: [selected, selected, forged] }));
    assert.equal(store.read('parent').revision, 7);
  }
});
