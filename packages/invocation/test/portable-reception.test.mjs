import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('the default reception branch authenticates concurrent explicit permits, revokes them on every exit and drains acceptances', async () => {
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      assert.ok(!['node:async_hooks', 'node:perf_hooks'].includes(specifier), `The portable invocation path loaded ${specifier}`);
      // Exercise the published package's default mapping with Node's ESM resolver.
      if (specifier === '#reception-scope') return nextResolve(specifier, { ...context, conditions: context.conditions.filter((condition) => condition !== 'node') });
      return nextResolve(specifier, context);
    },
  });
  try {
    const { Clock, InvocationChildren, InvocationContext } = await import('@weiliang0121/capix-invocation');
    const clock = new Clock();
    const start = clock.tick();
    assert.ok(Number.isFinite(start) && clock.tick() >= start);
    const parent = new InvocationContext(null);
    parent.start();
    const children = new InvocationChildren(parent);
    const foreign = new InvocationChildren(new InvocationContext(null));
    function returned(value) {
      const child = new InvocationContext(null);
      child.complete(value);
      const relation = children.attach({ context: child, run: async () => value });
      relation.returnedWith({ status: 'succeeded', output: value });
      return relation;
    }
    const relation = returned('delivered');
    const sibling = returned('sibling');
    const nested = returned('nested');
    const gate = Promise.withResolvers();
    let outerPermit;
    let siblingPermit;
    let nestedPermit;
    const accepted = relation.accept(async (output, permit) => {
      outerPermit = permit;
      await gate.promise;
      const origin = children.resolveReception(permit);
      assert.deepEqual(origin, { parentContextId: parent.id, childContextId: relation.invocation.context.id });
      assert.throws(() => children.reception, /explicit direct-child reception permit/);
      assert.throws(() => children.resolveReception(siblingPermit), /active direct-child reception permit/);
      assert.throws(() => children.resolveReception(Symbol()), /active direct-child reception permit/);
      assert.throws(() => foreign.resolveReception(permit), /active direct-child reception permit/);
      const failure = new Error('nested reception failed');
      await assert.rejects(
        nested.accept(async (_, inner) => {
          nestedPermit = inner;
          await Promise.resolve();
          assert.equal(children.resolveReception(inner).childContextId, nested.invocation.context.id);
          throw failure;
        }),
        (error) => error === failure,
      );
      assert.throws(() => children.resolveReception(nestedPermit), /active direct-child reception permit/);
      assert.deepEqual(children.resolveReception(permit), origin);
      return { output };
    });
    await sibling.accept(async (_, permit) => {
      siblingPermit = permit;
      await Promise.resolve();
      assert.notEqual(permit, outerPermit);
      assert.equal(children.resolveReception(permit).childContextId, sibling.invocation.context.id);
    });
    const drained = children.settleAcceptances();
    assert.ok(drained);
    assert.equal(relation.reception.status, 'receiving');
    gate.resolve();
    await drained;
    assert.deepEqual(relation.reception, { status: 'accepted', output: { output: 'delivered' } });
    assert.deepEqual(await accepted, { output: 'delivered' });
    assert.equal(children.settleAcceptances(), undefined);
    assert.throws(() => children.resolveReception(outerPermit), /active direct-child reception permit/);
  } finally {
    hook.deregister();
  }
});
