import assert from 'node:assert/strict';

import { test } from 'node:test';

import { InvocationResources, invocationResourceFailures } from '@weiliang0121/capix-invocation';

import { ResourceAccessClosed, ResourceOffer, ResourceSupply } from '@weiliang0121/capix-resources';

function windows(t, failures = new Map()) {
  const closed = [];
  const reported = [];
  const pending = [];
  const gates = [];
  let round = 1;
  let endpoints = 0;
  const offer = new ResourceOffer({
    capture: (value) => {
      endpoints++;
      return value;
    },
    methods: {
      hold(_origin, name, operation) {
        const gate = Promise.withResolvers();
        gates.push(gate);
        operation.onClose(() => {
          closed.push(name);
          if (failures.has(name)) throw failures.get(name);
        });
        return gate.promise;
      },
    },
  });
  const deps = { resource: offer.request() };
  const supply = ResourceSupply.capture([offer.provide(() => null)], undefined);
  const resources = new InvocationResources(deps, supply.entries);
  resources.attach({
    contextId: 'exit-resource-windows',
    failures: invocationResourceFailures,
    validate() {},
    round: () => round,
    error(error) {
      reported.push(error);
    },
  });
  resources.start();
  t.after(async () => {
    resources.closeAllResult();
    for (const gate of gates) gate.resolve('late result');
    await Promise.allSettled(pending);
  });
  return {
    resources,
    deps,
    closed,
    reported,
    get captures() {
      return endpoints;
    },
    start(name) {
      const endpoint = resources.view(deps).resource;
      const operation = endpoint.hold(name);
      pending.push(operation);
      void operation.catch(() => undefined);
      return endpoint;
    },
    nextRound() {
      round++;
      resources.activate('run', deps);
    },
  };
}

test('InvocationResources exhausts every owned window synchronously and reports all cleanup failures', async (t) => {
  const first = new Error('first cleanup');
  // Undefined is an actual thrown value, not an absent failure.
  const fixture = windows(
    t,
    new Map([
      ['first', first],
      ['second', undefined],
    ]),
  );
  const retained = [fixture.start('first')];
  fixture.nextRound();
  retained.push(fixture.start('second'));
  fixture.nextRound();
  retained.push(fixture.start('third'));
  let microtaskRan = false;
  queueMicrotask(() => {
    microtaskRan = true;
  });

  const result = fixture.resources.closeAllResult();
  assert.equal(microtaskRan, false);
  assert.equal(result.status, 'failed');
  assert.deepEqual(fixture.closed, ['first', 'second', 'third']);
  assert.ok(result.failure instanceof AggregateError);
  assert.equal(result.failure.errors.length, 2);
  assert.deepEqual(result.failure.errors, fixture.reported);
  assert.equal(result.failure.errors[0].cause, first);
  assert.equal(result.failure.errors[1].cause, undefined);
  assert.equal(Object.hasOwn(result.failure.errors[1], 'cause'), true);
  assert.equal(result.failure.cause, result.failure.errors[0]);

  assert.deepEqual(fixture.resources.closeAllResult(), { status: 'succeeded', value: undefined });
  assert.deepEqual(fixture.closed, ['first', 'second', 'third'], 'owned cleanups are not retried');
  for (const endpoint of retained) await assert.rejects(endpoint.hold('after close'), ResourceAccessClosed);
});

test('InvocationResources closeAll keeps the single failure identity and releases other windows', (t) => {
  const cleanup = new Error('cleanup');
  const fixture = windows(t, new Map([['failed', cleanup]]));
  fixture.start('failed');
  fixture.nextRound();
  fixture.start('healthy');

  let caught;
  try {
    fixture.resources.closeAll();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught, fixture.reported[0]);
  assert.equal(caught.cause, cleanup);
  assert.deepEqual(fixture.closed, ['failed', 'healthy']);
  assert.doesNotThrow(() => fixture.resources.closeAll());
});

test('InvocationResources does not open the next phase after the old phase fails to close', (t) => {
  const fixture = windows(t, new Map([['old phase', new Error('old cleanup')]]));
  fixture.start('old phase');
  const captured = fixture.captures;

  assert.throws(
    () => fixture.resources.activate('checkpoint:next', fixture.deps),
    (error) => error === fixture.reported[0],
  );
  assert.deepEqual(fixture.closed, ['old phase']);
  assert.equal(fixture.captures, captured);
  assert.throws(() => fixture.resources.view(fixture.deps, 'checkpoint:next').resource, ResourceAccessClosed);
  assert.deepEqual(fixture.resources.closeAllResult(), { status: 'succeeded', value: undefined });
});

test('InvocationResources closing before start is synchronous and permanently forbids start', () => {
  const resources = new InvocationResources({});
  assert.deepEqual(resources.closeAllResult(), { status: 'succeeded', value: undefined });
  assert.throws(() => resources.start(), /already started/);
});
