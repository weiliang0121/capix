import assert from 'node:assert/strict';

import { test } from 'node:test';

import { MemoryCheckpointStore, cloneCheckpointHead, cloneCheckpointImage, cloneCheckpointDelivery, CHECKPOINT_MAX_BYTES } from '@weiliang0121/capix-checkpoint';

function savedRoot(children) {
  return { id: 'root-cp', formatVersion: 6, contract: { key: 'root', version: 1 }, point: 'saved', frame: { owner: { contextId: 'root-context', kind: 'scene' }, round: 1, phase: 'execute', input: {}, currentInput: {}, nextChildOrder: children.length, children }, state: null, references: {} };
}

function returnedChild() {
  return { target: { position: 0 }, identity: { contextId: 'child-context', parentContextId: 'root-context', kind: 'group' }, contract: { key: 'child-a', version: 1 }, round: 1, order: 0, key: 'work', input: {}, state: { kind: 'returned', output: 'delivered', progress: { round: 1, phase: 'receive', currentInput: {} }, reception: { kind: 'pending' } } };
}

test('checkpoint head validation rejects accessors without evaluating them', () => {
  let reads = 0;
  const value = {
    get revision() {
      reads += 1;
      return 1;
    },
    get image() {
      reads += 1;
      return savedRoot([]);
    },
  };
  assert.throws(() => cloneCheckpointHead(value));
  assert.equal(reads, 0);
});

test('a valid image and final delivery stay decodable together after the store commits them', () => {
  const store = new MemoryCheckpointStore();
  const value = 'x'.repeat(Math.floor(CHECKPOINT_MAX_BYTES * 0.6));
  const image = { ...savedRoot([]), state: value };
  store.save(image, 0);
  store.finish('root-context', 1, { status: 'succeeded', output: value, progress: { round: 1, phase: 'receive', currentInput: {} } });
  assert.doesNotThrow(() => cloneCheckpointHead(store.read('root-context')));
});

test('fixed child deliveries require explicit final progress and stable sibling order', () => {
  for (const progress of [undefined, { round: 0, phase: 'receive', currentInput: {} }, { round: 3, phase: 'receive', currentInput: {} }, { round: 1, phase: 'receive' }, { round: 1, currentInput: {} }, { round: 1, phase: 'unknown', currentInput: {} }]) {
    const child = returnedChild();
    if (progress === undefined) delete child.state.progress;
    else child.state.progress = progress;
    assert.throws(() => cloneCheckpointImage(savedRoot([child])));
    assert.throws(() => cloneCheckpointDelivery({ status: 'succeeded', output: 'fixed', ...(progress ? { progress } : {}) }));
  }
  const first = returnedChild();
  const second = { ...returnedChild(), identity: { contextId: 'second-child', parentContextId: 'root-context', kind: 'group' }, order: 1 };
  assert.doesNotThrow(() => cloneCheckpointImage(savedRoot([first, second])));
  assert.throws(() => cloneCheckpointImage(savedRoot([second, first])), /order/);
});
