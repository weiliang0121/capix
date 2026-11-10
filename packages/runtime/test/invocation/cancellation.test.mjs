import { isInvocationCancelled } from '@weiliang0121/capix-invocation';

import { installCallable } from '../fixtures/driver.mjs';

import test from 'node:test';

import assert from 'node:assert/strict';

import { Scene, Group } from '@weiliang0121/capix-runtime';

import { ResourceOffer } from '@weiliang0121/capix-resources';

class Main extends Scene {
  constructor(execute, { children = [], deps = {} } = {}) {
    super();
    this.add(...children);
    this.deps = deps;
    this.run = execute;
  }
}

function runtime(definition, providers = []) {
  return installCallable(definition, { providers, source: { runtime: () => null, capture: () => undefined } });
}

test('cancellation blocks new children before entry and releases Runtime occupancy', async () => {
  const controller = new AbortController();
  const execution = new (class extends Group {
    deps = {};
    run = () => assert.fail('child must not run');
    entry = { deps: {}, accept: () => assert.fail('entry must not run') };
  })();
  let parent;
  const bound = runtime(
    new Main(
      (work) => {
        parent = work;
        controller.abort();
        try {
          work.children.create(execution, null);
        } catch {}
        return 'caught but not recovered';
      },
      { children: [execution] },
    ),
  );
  await assert.rejects(bound.run(null, { signal: controller.signal }), (error) => isInvocationCancelled(error, controller.signal));
  assert.equal(parent.children.facts.values().length, 0);
  assert.equal(bound.running, false);
});

test('a returned child is not accepted after parent cancellation', async () => {
  const controller = new AbortController();
  const execution = new (class extends Group {
    deps = {};
    run = () => 'child result';
  })();
  let relation;
  let acceptances = 0;
  const bound = runtime(
    new Main(
      async (work) => {
        const child = work.children.create(execution, null);
        await child.run();
        relation = work.children.facts.get(child.ref);
        controller.abort();
        return child.accept(() => acceptances++);
      },
      { children: [execution] },
    ),
  );
  await assert.rejects(bound.run(null, { signal: controller.signal }), (error) => isInvocationCancelled(error, controller.signal));
  assert.equal(acceptances, 0);
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'pending');
  assert.equal(bound.running, false);
});

test('cached resource endpoints stop later writes but preserve already established effects', async () => {
  const controller = new AbortController();
  const writes = [];
  const offer = new ResourceOffer({ name: 'test.write', expose: (_source, activity) => ({ append: (value) => activity.runSync('append', {}, () => writes.push(value)) }) });
  const bound = runtime(
    new Main(
      (work) => {
        const endpoint = work.resources.writer;
        endpoint.append('before');
        controller.abort();
        try {
          endpoint.append('after');
        } catch {}
        return 'ignored';
      },
      { deps: { writer: offer.request() } },
    ),
    [offer.provide(() => null)],
  );
  await assert.rejects(bound.run(null, { signal: controller.signal }), (error) => isInvocationCancelled(error, controller.signal));
  assert.deepEqual(writes, ['before']);
  assert.equal(bound.running, false);
});
