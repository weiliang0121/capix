import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, DeclaredException, Invocation, InvocationContext, inspectChildCallFailure } from '@weiliang0121/capix-invocation';

const rejected = new ExceptionContract('PRECISE_REJECTION');
const make = (execute, options = {}) => new Invocation({ context: new InvocationContext('initial'), signal: new AbortController().signal, work: { execute }, ...options });
const failing = (owner, error) =>
  make(
    () => {
      throw error;
    },
    { parent: { invocation: owner } },
  );

test('simultaneous identical exceptions retain the selected delivery source without key lookup', async () => {
  for (const selected of [0, 1]) {
    const exception = rejected.create('shared', {});
    const children = [];
    const parent = make(async (_context, owner) => {
      children.push(failing(owner, exception), failing(owner, exception));
      const results = await Promise.allSettled(children.map((child) => child.run()));
      assert.notEqual(results[0].reason, results[1].reason);
      assert.equal(results[selected].reason.exception, exception);
      assert.equal(results[selected].reason instanceof DeclaredException, false);
      throw results[selected].reason;
    });
    await assert.rejects(parent.run(), (error) => error === exception);
    assert.deepEqual(parent.failure.origin, { kind: 'child-return', child: { parentContextId: parent.context.id, childContextId: children[selected].context.id, parentRound: 1, order: selected } });
  }
});

test('rethrow preserves source and unwrapping or replacing the exception is a local throw', async () => {
  for (const mode of ['rethrow', 'unwrap', 'replace']) {
    const exception = rejected.create('child', {});
    const parent = make(async (_context, owner) => {
      try {
        await failing(owner, exception).run();
      } catch (error) {
        if (mode === 'rethrow') throw error;
        if (mode === 'unwrap') throw error.exception;
        throw rejected.create('parent', {});
      }
    });
    await assert.rejects(parent.run(), (error) => (mode === 'replace' ? error.message === 'parent' : error === exception));
    assert.equal(parent.failure.origin.kind, mode === 'rethrow' ? 'child-return' : 'self');
  }
});

test('a nested failure inside a reception preserves its actual child-return origin', async () => {
  const exception = rejected.create('nested', {});
  let nested;
  let outer;
  const parent = make(async (_context, owner) => {
    outer = make(() => 'outer result', { parent: { invocation: owner } });
    await outer.run();
    return owner.children.get(outer).accept(() => {
      nested = failing(owner, exception);
      return nested.run();
    });
  });
  await assert.rejects(parent.run(), (error) => error === exception);
  assert.equal(parent.failure.origin.kind, 'child-return');
  assert.equal(parent.failure.origin.child.childContextId, nested.context.id);
  assert.equal(parent.children.get(outer).reception.status, 'failed');
  assert.equal(parent.children.get(outer).returned.output, 'outer result');
});

test('a parent reception callback records its own exact child-reception source', async () => {
  const exception = rejected.create('reception', {});
  let child;
  const parent = make(async (_context, owner) => {
    child = make(() => 1, { parent: { invocation: owner } });
    await child.run();
    return owner.children.get(child).accept(() => {
      throw exception;
    });
  });
  await assert.rejects(parent.run(), (error) => error === exception);
  assert.equal(parent.failure.origin.kind, 'child-reception');
  assert.equal(parent.failure.origin.child.childContextId, child.context.id);
});

test('a delivery cannot cross parent invocations even when the same error instance is reused', async () => {
  let saved;
  const owner = make(async (_context, parent) => {
    try {
      await failing(parent, rejected.create('child', {})).run();
    } catch (error) {
      saved = error;
    }
    return 'finished';
  });
  await owner.run();
  assert.equal(inspectChildCallFailure(saved).origin.kind, 'child-return');
  const other = make(() => {
    throw saved;
  });
  await assert.rejects(other.run(), (error) => error.code === 'INVALID_EXCEPTION_DELIVERY');
});

test('unknown or forged delivery objects confer no exception authority', async () => {
  let saved;
  const parent = make(async (_context, owner) => {
    try {
      await failing(owner, rejected.create('child', {})).run();
    } catch (error) {
      saved = error;
    }
    const forged = new saved.constructor(saved.exception);
    assert.equal(inspectChildCallFailure(forged), undefined);
    throw forged;
  });
  await assert.rejects(parent.run(), (error) => error.code === 'INVALID_EXCEPTION_DELIVERY');
});

test('catching a technical reception failure cannot clear parent fault ownership', async () => {
  const failure = new Error('invalid reception');
  const parent = make(async (_context, owner) => {
    const child = make(() => 'value', { parent: { invocation: owner } });
    await child.run();
    try {
      await owner.children.get(child).accept(() => {
        throw failure;
      });
    } catch {}
    return 'forged success';
  });
  await assert.rejects(parent.run(), (error) => error === failure);
});
