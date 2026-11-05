import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore, cloneCheckpointImage, cloneCheckpointDelivery } from '@capix/checkpoint';

function image(id = 'cp-1', contextId = 'scope-1') {
  return { id, formatVersion: 5, contract: { key: 'fixture', version: 1 }, point: 'accepted', frame: { owner: { contextId, kind: 'scene' }, round: 1, phase: 'execute', input: { content: 'input' }, currentInput: { content: 'input' }, nextChildOrder: 0, children: [] }, state: { content: 'saved' }, references: {} };
}

test('memory checkpoint storage fixes caller values and rejects stale or duplicate progress', () => {
  const store = new MemoryCheckpointStore();
  const source = image();
  const receipt = store.save(source, 0);
  const saved = store.read('scope-1');
  assert.equal(receipt.kind, 'saved');
  assert.equal(receipt.contextId, 'scope-1');
  assert.equal(receipt.checkpointId, 'cp-1');
  assert.equal(receipt.revision, 1);
  assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  assert.equal('image' in receipt, false);
  assert.equal(Object.isFrozen(receipt), true);
  source.state.content = 'changed';
  assert.equal(store.read('scope-1').image.state.content, 'saved');
  assert.equal(Object.isFrozen(saved.image.state), true);
  assert.throws(() => store.save(image('cp-2'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.throws(() => store.save(image(), 1), { code: 'CHECKPOINT_CONFLICT' });
  assert.throws(() => store.save(image('cp-1', 'scope-2'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(store.read('scope-2'), undefined);
  assert.equal(store.read('scope-1'), saved);
  assert.equal(store.save(image('cp-2'), 1).revision, 2);
  assert.equal(saved.image.id, 'cp-1', 'existing captured heads stay unchanged');
});

test('memory checkpoint advancement keeps owner, original input and contract fixed', () => {
  for (const mutate of [(next) => (next.frame.owner.kind = 'group'), (next) => (next.frame.owner.parentContextId = 'parent'), (next) => (next.frame.input = 'changed'), (next) => (next.contract.version = 2)]) {
    const store = new MemoryCheckpointStore();
    store.save(image(), 0);
    const saved = store.read('scope-1');
    const next = image('cp-2');
    mutate(next);
    assert.throws(() => store.save(next, 1), { code: 'CHECKPOINT_CONFLICT' });
    assert.equal(store.read('scope-1'), saved);
  }
});

for (const status of ['succeeded', 'failed', 'cancelled']) {
  test(`memory checkpoint ${status} delivery closes the scope`, () => {
    const store = new MemoryCheckpointStore();
    store.save(image(), 0);
    const delivery = status === 'succeeded' ? { status, output: { content: 'final' }, progress: { round: 1, phase: 'receive', currentInput: {} } } : { status };
    assert.throws(() => store.finish('scope-1', 0, delivery), { code: 'CHECKPOINT_CONFLICT' });
    const receipt = store.finish('scope-1', 1, delivery);
    const finished = store.read('scope-1');
    assert.equal(receipt.kind, 'finished');
    assert.equal(receipt.contextId, 'scope-1');
    assert.equal(receipt.checkpointId, 'cp-1');
    assert.equal(receipt.revision, 2);
    assert.equal(receipt.status, status);
    assert.match(receipt.digest, /^[a-f0-9]{64}$/);
    assert.equal('image' in receipt, false);
    assert.equal('delivery' in receipt, false);
    if (status === 'succeeded') delivery.output.content = 'caller mutation';
    assert.equal(finished.revision, 2);
    assert.equal(finished.delivery.status, status);
    if (status === 'succeeded') assert.equal(finished.delivery.output.content, 'final');
    assert.throws(() => store.save(image('cp-2'), 2), { code: 'CHECKPOINT_CONFLICT' });
    assert.throws(() => store.finish('scope-1', 2, { status: 'cancelled' }), { code: 'CHECKPOINT_CONFLICT' });
    assert.equal(store.read('scope-1'), finished);
    assert.throws(() => store.finish('missing', 0, { status: 'failed' }), { code: 'CHECKPOINT_CONFLICT' });
  });
}

// Store accepts certified whole values without creating a second recovery payload.
test('memory checkpoint storage reuses certified image and delivery while returning only acknowledgements', () => {
  const store = new MemoryCheckpointStore();
  const fixedImage = cloneCheckpointImage(image());
  const saved = store.save(fixedImage, 0);
  assert.equal(store.read('scope-1').image, fixedImage);
  const fixedDelivery = cloneCheckpointDelivery({ status: 'succeeded', output: { content: 'final' }, progress: { round: 1, phase: 'receive', currentInput: {} } });
  const finished = store.finish('scope-1', saved.revision, fixedDelivery);
  const head = store.read('scope-1');
  assert.equal(head.image, fixedImage);
  assert.equal(head.delivery, fixedDelivery);
  assert.equal(finished.revision, head.revision);
  assert.equal('image' in finished, false);
  assert.equal('delivery' in finished, false);
});
