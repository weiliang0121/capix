import assert from 'node:assert/strict';

import { test } from 'node:test';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

const identity = { encode: (value) => value, decode: (value) => value };

test('terminal publication rejects a lossy output codec before persisting successful delivery', async () => {
  const context = new InvocationContext(null);
  const store = new MemoryCheckpointStore();
  let decodes = 0;
  const finishes = [];
  const port = {
    read: (id) => store.read(id),
    save: (...args) => store.save(...args),
    finish(id, revision, delivery) {
      finishes.push(delivery);
      return store.finish(id, revision, delivery);
    },
  };
  const binding = {
    key: 'lossy-finish',
    version: 1,
    input: identity,
    output: {
      encode: () => 'different',
      decode: (value) => {
        decodes++;
        return value;
      },
    },
    points: { saved: { state: identity, references: {}, execute: () => assert.fail('not recovering') } },
  };
  const invocation = new Invocation({
    context,
    identity: { contextId: context.id, kind: 'node' },
    signal: new AbortController().signal,
    checkpoints: { store: port },
    work: {
      maxRounds: 1,
      checkpoint: binding,
      execute(_context, current) {
        current.checkpointWriter.save('saved', null);
        return 'actual';
      },
    },
  });
  await assert.rejects(invocation.run(), /preserve.*established value/);
  assert.equal(decodes, 1);
  assert.equal(context.state.output, 'actual', 'work completion still records the actual stable result');
  assert.ok(finishes.every((delivery) => delivery.status !== 'succeeded'));
  assert.notEqual(store.read(context.id).delivery?.status, 'succeeded');
});

test('low-level checkpoint lazy queries expire with their own save cut and never reopen', async () => {
  const context = new InvocationContext(null);
  const store = new MemoryCheckpointStore();
  let first;
  let checks = 0;
  const assertExpired = () => {
    assert.throws(() => first.frame.children, /outside|expired/);
    assert.throws(() => first.decoded.children, /outside|expired/);
    assert.throws(() => first.decoded.child('missing'), /outside|expired/);
  };
  const binding = {
    key: 'cut-lifetime',
    version: 1,
    input: identity,
    output: identity,
    points: {
      saved: {
        state: identity,
        references: {},
        check(frame, _state, _refs, decoded) {
          checks++;
          if (first) assertExpired();
          else first = { frame, decoded };
          assert.deepEqual(frame.children, []);
          assert.equal(decoded.child('missing'), undefined);
        },
        execute: () => assert.fail('not recovering'),
      },
    },
  };
  const invocation = new Invocation({
    context,
    identity: { contextId: context.id, kind: 'node' },
    signal: new AbortController().signal,
    checkpoints: { store },
    work: {
      maxRounds: 1,
      checkpoint: binding,
      execute(_context, current) {
        current.checkpointWriter.save('saved', 1);
        assertExpired();
        current.checkpointWriter.save('saved', 2);
        assertExpired();
        return 'done';
      },
    },
  });
  assert.equal(await invocation.run(), 'done');
  assert.equal(checks, 2);
  assertExpired();
});

test('checkpoint checks cannot rewrite relation metadata after declaration authentication', async () => {
  const context = new InvocationContext(null);
  const store = new MemoryCheckpointStore();
  const signal = new AbortController().signal;
  const childBinding = { key: 'metadata-child', version: 1, input: identity, output: identity, points: {} };
  const reception = { position: 0, childPosition: 0, codec: identity, check() {} };
  const states = [];
  const writes = [];
  let escaped;
  const attempts = (child) => {
    for (const [object, key, value] of [
      [child.identity, 'contextId', 'forged-child'],
      [child.target, 'position', 1],
      [child.contract, 'key', 'forged-contract'],
      [child.state, 'kind', 'waiting'],
      ...(child.state.kind === 'waiting'
        ? []
        : [
            [child.state.progress, 'phase', 'receive'],
            [child.state.reception, 'kind', 'pending'],
          ]),
      ...(child.state.reception?.contract ? [[child.state.reception.contract, 'position', 1]] : []),
    ]) {
      assert.equal(Object.isFrozen(object), true);
      assert.throws(() => {
        object[key] = value;
      }, TypeError);
    }
  };
  const binding = {
    key: 'metadata-parent',
    version: 1,
    input: identity,
    output: identity,
    children: [
      { kind: 'node', binding: childBinding },
      { kind: 'node', binding: childBinding },
    ],
    receptions: [reception],
    points: {
      saved: {
        state: identity,
        references: {},
        check(frame, _state, _refs, decoded) {
          const child = frame.children[0];
          attempts(child);
          attempts(decoded.children[0]);
          states.push(child.state.kind === 'waiting' ? 'waiting' : child.state.reception.kind);
          escaped ??= child;
        },
        execute() {
          assert.fail('not recovering');
        },
      },
    },
  };
  const port = {
    read: (id) => store.read(id),
    save(commit, revision) {
      writes.push(commit);
      return store.save(commit, revision);
    },
    finish: (...args) => store.finish(...args),
  };
  const invocation = new Invocation({
    context,
    signal,
    identity: { contextId: context.id, kind: 'group' },
    checkpoints: { store: port },
    work: {
      checkpoint: binding,
      async execute(_context, parent) {
        const childContext = new InvocationContext({ query: 'original' });
        const child = new Invocation({
          context: childContext,
          signal,
          identity: { contextId: childContext.id, parentContextId: context.id, kind: 'node' },
          parent: { invocation: parent, declarationPosition: 0 },
          work: { checkpoint: childBinding, execute: () => ({ answer: 'original' }) },
        });
        parent.checkpointWriter.save('saved', null);
        attempts(escaped);
        await child.run();
        parent.checkpointWriter.save('saved', null);
        await parent.children.get(child).accept((value) => {
          parent.checkpointWriter.save('saved', null);
          return { accepted: value };
        }, reception);
        parent.checkpointWriter.save('saved', null);
        parent.checkpointWriter.save('saved', null);
        assert.equal(parent.children.get(child).declarationPosition, 0);
        return null;
      },
    },
  });
  await invocation.run();
  assert.deepEqual(states, ['waiting', 'pending', 'receiving', 'accepted', 'accepted']);
  assert.equal(writes.at(-1).children.length, 0, 'unchanged envelopes do not need to be republished');
  for (const commit of writes) for (const child of commit.children) attempts(child);
  const child = store.read(context.id).image.frame.children[0];
  assert.equal(child.target.position, 0);
  assert.equal(child.contract.key, childBinding.key);
  assert.equal(child.state.progress.phase, 'execute');
  assert.equal(child.state.reception.kind, 'accepted');
  assert.equal(child.state.reception.contract.position, 0);
});

function reviewImage(id, owner, contract, input, state = null, children = []) {
  return {
    id,
    formatVersion: 6,
    contract,
    point: 'saved',
    frame: { owner, phase: 'execute', round: 1, input, currentInput: input, nextChildOrder: children.length, children },
    state,
    references: {},
  };
}

test('real waiting-child recovery distinguishes negative zero from a different durable input', async (t) => {
  for (const input of [-0, 0])
    await t.test(Object.is(input, -0) ? 'matching negative zero resumes' : 'positive zero is refused', async () => {
      const store = new MemoryCheckpointStore();
      const owner = { contextId: 'signed-parent', kind: 'group' };
      const childOwner = { contextId: 'signed-child', parentContextId: owner.contextId, kind: 'node' };
      const parentContract = { key: 'signed-parent', version: 1 };
      const childContract = { key: 'signed-child', version: 1 };
      const savedChild = { identity: childOwner, contract: childContract, target: { position: 0 }, round: 1, order: 0, input: -0, state: { kind: 'waiting' } };
      store.save(reviewImage('signed-parent-image', owner, parentContract, null, null, [savedChild]), 0);
      store.save(reviewImage('signed-child-image', childOwner, childContract, input), 0);
      store.finish(childOwner.contextId, 1, { status: 'succeeded', output: 'durable result', progress: { round: 1, currentInput: input, phase: 'execute' } });
      let received = 0;
      const binding = {
        ...parentContract,
        input: identity,
        output: identity,
        children: [{ kind: 'node', binding: { ...childContract, input: identity, output: identity } }],
        points: {
          saved: {
            state: identity,
            references: {},
            execute(_context, parent) {
              const child = parent.restoreChild(0, childOwner.contextId, () => assert.fail('the child body must not restart'));
              assert.ok(Object.is(child.context.input, -0));
              received++;
              return child.context.state.output;
            },
          },
        },
      };
      const context = new InvocationContext(null);
      context.installCheckpoint({ id: owner.contextId, round: 1, currentInput: null });
      const invocation = new Invocation({ context, identity: owner, signal: new AbortController().signal, checkpoints: { store }, restore: { head: store.read(owner.contextId) }, work: { checkpoint: binding, execute: () => assert.fail('root must resume') } });
      if (Object.is(input, -0)) {
        assert.equal(await invocation.run(), 'durable result');
        assert.equal(received, 1);
      } else {
        await assert.rejects(invocation.run(), /differs from parent-owned identity/);
        assert.equal(received, 0);
      }
    });
});

test('restored root input and current input both retain signed-zero identity', () => {
  const store = new MemoryCheckpointStore();
  const owner = { contextId: 'signed-root', kind: 'group' };
  const contract = { key: 'signed-root', version: 1 };
  store.save(reviewImage('signed-root-image', owner, contract, -0), 0);
  const binding = { ...contract, input: identity, output: identity, points: { saved: { state: identity, references: {}, execute: () => null } } };
  for (const [input, currentInput] of [
    [0, -0],
    [-0, 0],
  ]) {
    const context = new InvocationContext(input);
    context.installCheckpoint({ id: owner.contextId, round: 1, currentInput });
    assert.throws(() => new Invocation({ context, identity: owner, signal: new AbortController().signal, checkpoints: { store }, restore: { head: store.read(owner.contextId) }, work: { checkpoint: binding, execute: () => null } }), /input changed during binding/);
  }
});

test('cold head authentication rejects changed signed-zero state at construction and begin', async (t) => {
  for (const phase of ['fallback', 'begin'])
    await t.test(phase, async () => {
      const original = new MemoryCheckpointStore();
      const current = new MemoryCheckpointStore();
      const owner = { contextId: 'signed-state', kind: 'group' };
      const contract = { key: 'signed-state', version: 1 };
      original.save(reviewImage('signed-state-image', owner, contract, null, -0), 0);
      current.save(reviewImage('signed-state-image', owner, contract, null, 0), 0);
      let resumed = 0;
      const binding = {
        ...contract,
        input: identity,
        output: identity,
        points: {
          saved: {
            state: identity,
            references: {},
            execute: () => {
              resumed++;
              return null;
            },
          },
        },
      };
      const context = new InvocationContext(null);
      context.installCheckpoint({ id: owner.contextId, round: 1, currentInput: null });
      const known = original.read(owner.contextId);
      const head = phase === 'fallback' ? { revision: known.revision, image: known.image } : known;
      const construct = () => new Invocation({ context, identity: owner, signal: new AbortController().signal, checkpoints: { store: current }, restore: { head }, work: { checkpoint: binding, execute: () => assert.fail('root must resume') } });
      if (phase === 'fallback') assert.throws(construct, /publication differs/);
      else await assert.rejects(construct().run(), /head changed before continuation/);
      assert.equal(resumed, 0);
    });
});
