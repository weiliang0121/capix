import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ResourceAccess, ResourceAccessClosed, ResourceOffer, Resource, Resources } from '@weiliang0121/capix-resources';

for (const failure of [new Error('eager exposure failed'), undefined]) {
  test(`resource opening retains ${failure === undefined ? 'throw undefined' : 'original exposure failure'} when partial-operation cleanup fails`, async () => {
    const cleanup = new Error('cleanup during opening');
    const response = Promise.withResolvers();
    let pending;
    let retained;
    const events = [];
    const started = new ResourceOffer({
      timing: 'binding',
      expose(_origin, activity) {
        retained = activity;
        pending = activity.operate('opening operation', {}, (operation) => {
          operation.onClose(() => {
            events.push('closed');
            throw cleanup;
          });
          return response.promise;
        });
        void pending.catch(() => undefined);
        return {};
      },
    });
    const failed = new ResourceOffer({
      timing: 'binding',
      expose() {
        throw failure;
      },
    });
    const registry = new Resources().register(new Resource(null), started).register(new Resource(null), failed);
    let delivered;
    let threw = false;
    try {
      registry.bind({ started: started.request(), failed: failed.request() }).open();
    } catch (error) {
      threw = true;
      delivered = error;
    } finally {
      response.resolve('late');
      await pending.catch(() => undefined);
    }
    assert.equal(threw, true);
    assert.ok(delivered instanceof AggregateError);
    assert.equal(delivered.errors[0], failure);
    assert.equal(delivered.cause, failure);
    assert.equal(delivered.errors[1].cause, cleanup);
    assert.deepEqual(events, ['closed']);
    assert.throws(() => retained.validate(), ResourceAccessClosed);
  });
}

test('resource construction retains a thrown undefined without interpreting it as absent', () => {
  let threw = false;
  try {
    new ResourceAccess({}, () => {
      throw undefined;
    });
  } catch (failure) {
    threw = true;
    assert.equal(failure, undefined);
  }
  assert.equal(threw, true);
});
