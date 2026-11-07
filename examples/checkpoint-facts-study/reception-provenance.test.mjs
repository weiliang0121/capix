import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resource, ResourceOffer, Resources } from '@capix/resources';
import { invocationResourceFailures } from '@capix/invocation';
import { createBoundaryCall } from './action-boundaries.mjs';

// This is the existing public provenance seam. It supplies identity, not an
// idempotency promise: only an entity that stores/compares receipts can add that.
const offer = new ResourceOffer({
  expose: (origin, activity) => ({
    read() {
      return activity.runSync('read', {}, () => origin.text);
    },
    operation(position) {
      return activity.runSync('operation', {}, () => ({ ...activity.reception(), position }));
    },
  }),
});

test('concurrent receptions supply their actual parent/child provenance through the resource port', async () => {
  const resources = new Resources().register(new Resource({ text: 'ordinary data' }), offer);
  const binding = resources.bind({ evidence: offer.request() });
  const ready = [Promise.withResolvers(), Promise.withResolvers()];
  const release = [Promise.withResolvers(), Promise.withResolvers()];
  const expected = [];
  let access;
  const parent = createBoundaryCall({
    async execute(_context, invocation) {
      access = binding.open({ contextId: invocation.context.id, failures: invocationResourceFailures, validate: () => invocation.requireActive(), reception: () => invocation.children.reception });
      assert.equal(access.endpoints.evidence.read(), 'ordinary data');
      assert.throws(() => access.endpoints.evidence.operation('outside-reception'));
      const children = [0, 1].map((index) => createBoundaryCall({ parent: invocation, input: index, execute: () => 'same value' }));
      await Promise.all(children.map((child) => child.run()));
      const receiving = children.map((child, index) =>
        invocation.children.get(child).accept(async () => {
          ready[index].resolve();
          await release[index].promise;
          const before = access.endpoints.evidence.operation('first');
          await Promise.resolve();
          const after = access.endpoints.evidence.operation('second');
          expected[index] = { parentContextId: invocation.context.id, childContextId: child.context.id };
          return { before, after };
        }),
      );
      await Promise.all(ready.map((entry) => entry.promise));
      release[1].resolve();
      await receiving[1];
      release[0].resolve();
      const results = await Promise.all(receiving);
      assert.throws(() => access.endpoints.evidence.operation('expired-reception'));
      return results;
    },
  });
  try {
    const results = await parent.run();
    for (const [index, result] of results.entries()) {
      assert.deepEqual(result.before, { ...expected[index], position: 'first' });
      assert.deepEqual(result.after, { ...expected[index], position: 'second' });
    }
    assert.notEqual(results[0].before.childContextId, results[1].before.childContextId);
  } finally {
    access?.close();
  }
});

test('ordinary resource access needs no reception identity; fixed provenance without an owner is rejected', () => {
  const resources = new Resources().register(new Resource({ text: 'ordinary data' }), offer);
  const access = resources.bind({ evidence: offer.request() }).open();
  try {
    assert.equal(access.endpoints.evidence.read(), 'ordinary data');
    assert.throws(() => access.endpoints.evidence.operation('receipt'));
  } finally {
    access.close();
  }
});
