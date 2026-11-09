import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationChildren, InvocationContext } from '@weiliang0121/capix-invocation';

function owner() {
  const context = new InvocationContext(null);
  context.start();
  return { context, children: new InvocationChildren(context) };
}

function returned(parent, value = 'candidate') {
  const context = new InvocationContext(null);
  context.complete(value);
  const relation = parent.children.attach({ context, run: async () => value });
  relation.returnedWith({ status: 'succeeded', output: value });
  return relation;
}

function expectReception(parent, relation) {
  assert.deepEqual(parent.children.reception, { parentContextId: parent.context.id, childContextId: relation.invocation.context.id });
}

function expectUnavailable(parent) {
  assert.throws(() => parent.children.reception, /active direct-child reception/);
}

test('nested owners retain their own active reception through asynchronous work', async () => {
  const outer = owner();
  const inner = owner();
  const unrelated = owner();
  const first = returned(outer);
  const second = returned(inner);
  expectUnavailable(outer);
  expectUnavailable(inner);

  await first.accept(async () => {
    expectReception(outer, first);
    expectUnavailable(inner);
    await second.accept(async () => {
      expectReception(outer, first);
      expectReception(inner, second);
      expectUnavailable(unrelated);
      await Promise.resolve();
      expectReception(outer, first);
      expectReception(inner, second);
      return 'inner accepted';
    });
    expectReception(outer, first);
    expectUnavailable(inner);
    return 'outer accepted';
  });
  expectUnavailable(outer);
  expectUnavailable(inner);
});

test('concurrent receptions isolate siblings and owners without hiding awaited identities', async () => {
  const firstOwner = owner();
  const secondOwner = owner();
  const first = returned(firstOwner);
  const sibling = returned(firstOwner);
  const foreign = returned(secondOwner);
  const gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  const entered = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  const calls = [
    [firstOwner, first, secondOwner],
    [firstOwner, sibling, secondOwner],
    [secondOwner, foreign, firstOwner],
  ].map(([parent, relation, other], index) =>
    relation.accept(async () => {
      expectReception(parent, relation);
      expectUnavailable(other);
      entered[index].resolve();
      await gates[index].promise;
      expectReception(parent, relation);
      expectUnavailable(other);
      return index;
    }),
  );

  await Promise.all(entered.map((gate) => gate.promise));
  expectUnavailable(firstOwner);
  expectUnavailable(secondOwner);
  for (const index of [2, 1, 0]) {
    gates[index].resolve();
    assert.equal(await calls[index], index);
  }
  expectUnavailable(firstOwner);
  expectUnavailable(secondOwner);
});

test('an escaped inner reception cannot borrow an active outer reception of the same owner', async () => {
  const parent = owner();
  const outer = returned(parent);
  const inner = returned(parent);
  const late = Promise.withResolvers();
  let escaped;

  await outer.accept(async () => {
    expectReception(parent, outer);
    await inner.accept(async () => {
      expectReception(parent, inner);
      escaped = late.promise.then(() => expectUnavailable(parent));
      await Promise.resolve();
      expectReception(parent, inner);
      return 'inner accepted';
    });
    // The outer callback is still active. Only the escaped inner callback is closed.
    expectReception(parent, outer);
    late.resolve();
    await escaped;
    expectReception(parent, outer);
    return 'outer accepted';
  });
  expectUnavailable(parent);
});

test('a failed reception closes its escaped scope before another reception begins', async () => {
  const parent = owner();
  const failed = returned(parent);
  const next = returned(parent);
  const late = Promise.withResolvers();
  const failure = new Error('reception rejected');
  let escaped;
  await assert.rejects(
    failed.accept(() => {
      expectReception(parent, failed);
      escaped = late.promise.then(() => expectUnavailable(parent));
      throw failure;
    }),
    (error) => error === failure,
  );
  expectUnavailable(parent);

  await next.accept(async () => {
    expectReception(parent, next);
    late.resolve();
    await escaped;
    expectReception(parent, next);
    return 'next accepted';
  });
  expectUnavailable(parent);
});
