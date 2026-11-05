import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore, cloneCheckpointHead, checkpointReference } from '@capix/checkpoint';
import { Invocation, InvocationContext } from '@capix/invocation';

function createContracts() {
  const codec = { encode: (value) => value, decode: (value) => value };
  const reception = {
    position: 0,
    childPosition: 0,
    check: (value) => assert.equal(typeof value.acceptedText, 'string'),
    codec: { encode: (value) => value.acceptedText, decode: (value) => ({ acceptedText: value }) },
  };
  const childCheckpoint = {
    key: 'invocation-boundary.child',
    version: 1,
    input: codec,
    output: codec,
    points: { started: { state: codec, execute: () => assert.fail('a fixed child delivery must not execute again') } },
  };
  return { codec, reception, childCheckpoint };
}

// The host restores pure persisted values into a fresh Store. Neither construction
// objects nor live calls cross this boundary; no Scene, Binder or Runner is involved.
function install(store, saved) {
  const copy = cloneCheckpointHead(JSON.parse(JSON.stringify(saved)));
  const receipt = store.save(copy.image, 0);
  if (copy.delivery) store.finish(copy.image.frame.owner.contextId, receipt.revision, copy.delivery);
  return store.read(copy.image.frame.owner.contextId);
}

function parentCall(store, counts, execute, restored) {
  const contracts = createContracts();
  const { codec, reception, childCheckpoint } = contracts;
  const context = new InvocationContext({ word: 'hello' });
  if (restored) context.installCheckpoint({ id: restored.image.frame.owner.contextId, round: restored.image.frame.round, currentInput: restored.image.frame.currentInput });
  const selected = { cardinality: 'one', position: 0 };
  const checkpoint = {
    key: 'invocation-boundary.parent',
    version: 1,
    input: codec,
    output: codec,
    children: [{ kind: 'node', binding: childCheckpoint }],
    receptions: [reception],
    points: {
      waiting: {
        state: codec,
        references: { selected },
        check(frame) {
          assert.equal(frame.children.length, 1);
          assert.equal(frame.children[0].state.kind, 'waiting');
        },
        async execute(_context, parent, _state, refs) {
          const child = parent.restoreChild(0, refs.selected.contextId, () => {
            counts.reconstructed++;
            assert.fail('a fixed child delivery must not construct a new call');
          });
          assert.deepEqual(await child.run(), { text: '你好' });
          const relation = parent.children.get(child);
          assert.equal(relation.reception.status, 'pending');
          const result = await relation.accept((value) => {
            counts.received++;
            return { acceptedText: `${value.text}！` };
          }, reception);
          parent.checkpointWriter.save('accepted', null, refs);
          return result;
        },
      },
      accepted: {
        state: codec,
        references: { selected },
        check(_frame, _state, _refs, facts) {
          assert.equal(facts.children[0].state.reception.kind, 'accepted');
          assert.deepEqual(facts.children[0].state.reception.output, { acceptedText: '你好！' });
        },
        execute(_context, parent, _state, refs) {
          const child = parent.restoreChild(0, refs.selected.contextId, () => assert.fail('accepted facts do not reconstruct a child'));
          const relation = parent.children.get(child);
          assert.equal(relation.returned.status, 'succeeded');
          assert.equal(relation.reception.status, 'accepted');
          assert.equal(relation.reception.contract, reception);
          // Reception is already complete. Continue from its decoded result instead
          // of running either the child body or the business receiver again.
          return relation.reception.output;
        },
      },
    },
  };
  return new Invocation({
    context,
    identity: { contextId: context.id, kind: 'group' },
    signal: new AbortController().signal,
    checkpoints: { store },
    ...(restored ? { restore: { head: restored } } : {}),
    work: { checkpoint, execute: execute ? (context, owner) => execute(context, owner, contracts) : () => assert.fail('restoration must enter its declared point') },
  });
}

async function captureBoundaries() {
  const store = new MemoryCheckpointStore();
  const counts = { executed: 0, received: 0, reconstructed: 0 };
  const saved = {};
  const parent = parentCall(store, counts, async (context, owner, { reception, childCheckpoint }) => {
    const childContext = new InvocationContext(context.input.word);
    const child = new Invocation({
      context: childContext,
      identity: { contextId: childContext.id, parentContextId: context.id, kind: 'node' },
      signal: new AbortController().signal,
      parent: { invocation: owner, declarationPosition: 0 },
      checkpoints: { store },
      work: {
        checkpoint: childCheckpoint,
        execute(_context, invocation) {
          counts.executed++;
          invocation.checkpointWriter.save('started', null);
          return { text: '你好' };
        },
      },
    });
    const relation = owner.children.get(child);
    const refs = { selected: checkpointReference({ identity: child.identity, target: { position: 0 }, round: relation.round, order: relation.order }) };
    owner.checkpointWriter.save('waiting', null, refs);
    saved.waiting = store.read(context.id);
    await child.run();
    saved.child = store.read(child.context.id);
    const result = await relation.accept((value) => {
      counts.received++;
      return { acceptedText: `${value.text}！` };
    }, reception);
    owner.checkpointWriter.save('accepted', null, refs);
    saved.accepted = store.read(context.id);
    return result;
  });
  assert.deepEqual(await parent.run(), { acceptedText: '你好！' });
  // These are snapshots of actual save boundaries before parent final delivery;
  // the live fixture may complete without changing either immutable snapshot.
  assert.equal(saved.waiting.delivery, undefined);
  assert.equal(saved.accepted.delivery, undefined);
  assert.equal(saved.child.delivery.status, 'succeeded');
  return { saved, counts, parent };
}

test('invocation CP boundary consumes a fixed child delivery and later continues from accepted facts', async () => {
  const { saved, counts, parent } = await captureBoundaries();
  const waitingStore = new MemoryCheckpointStore();
  const waiting = install(waitingStore, saved.waiting);
  install(waitingStore, saved.child);
  const resumed = parentCall(waitingStore, counts, undefined, waiting);
  assert.deepEqual(await resumed.run(), { acceptedText: '你好！' });
  assert.deepEqual(counts, { executed: 1, received: 2, reconstructed: 0 });
  assert.equal(resumed.context.id, saved.waiting.image.frame.owner.contextId);
  assert.equal(waitingStore.read(resumed.context.id).delivery.status, 'succeeded');

  const acceptedStore = new MemoryCheckpointStore();
  // The complete parent frame already contains the accepted delivery. No child
  // Store record is necessary and the parent business state contains no result.
  const accepted = install(acceptedStore, saved.accepted);
  assert.equal(accepted.image.state, null);
  assert.equal(acceptedStore.read(saved.child.image.frame.owner.contextId), undefined);
  const continued = parentCall(acceptedStore, counts, undefined, accepted);
  assert.deepEqual(await continued.run(), { acceptedText: '你好！' });
  assert.deepEqual(counts, { executed: 1, received: 2, reconstructed: 0 });
  assert.equal(acceptedStore.read(continued.context.id).delivery.status, 'succeeded');

  // Each host construction rebuilt declarations/codecs. Persistent positions and
  // versions associate them with saved facts; old in-memory identity is not used.
  const original = parent.children.values()[0];
  for (const restored of [resumed, continued]) {
    const relation = restored.children.values()[0];
    assert.notEqual(restored.checkpointBinding, parent.checkpointBinding);
    assert.equal(restored.checkpointBinding.key, parent.checkpointBinding.key);
    assert.equal(restored.checkpointBinding.version, parent.checkpointBinding.version);
    assert.notEqual(relation.invocation.checkpointBinding, original.invocation.checkpointBinding);
    assert.equal(relation.invocation.checkpointBinding.key, original.invocation.checkpointBinding.key);
    assert.equal(relation.invocation.checkpointBinding.version, original.invocation.checkpointBinding.version);
    assert.equal(relation.declarationPosition, original.declarationPosition);
    assert.notEqual(relation.reception.contract, original.reception.contract);
    assert.notEqual(relation.reception.contract.codec, original.reception.contract.codec);
    assert.equal(relation.reception.contract.position, original.reception.contract.position);
    assert.equal(relation.reception.contract.childPosition, original.reception.contract.childPosition);
  }
});

test('invocation CP boundary rejects missing or mismatched child evidence before reconstructing work', async () => {
  const { saved, counts } = await captureBoundaries();
  for (const mismatch of ['missing', 'input']) {
    const store = new MemoryCheckpointStore();
    const waiting = install(store, saved.waiting);
    if (mismatch === 'input') {
      const changed = structuredClone(saved.child);
      changed.image.frame.input = 'another request';
      changed.image.frame.currentInput = 'another request';
      changed.delivery.progress.currentInput = 'another request';
      install(store, changed);
    }
    const call = parentCall(store, counts, undefined, waiting);
    await assert.rejects(call.run(), mismatch === 'missing' ? /no durable continuation/ : /differs from parent-owned identity/);
    assert.equal(call.context.status, 'failed');
    assert.equal(call.children.values()[0].reception.status, 'pending');
    assert.equal(store.read(call.context.id).delivery.status, 'failed');
  }
  assert.deepEqual(counts, { executed: 1, received: 1, reconstructed: 0 });
});
