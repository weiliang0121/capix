import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactType } from '@weiliang0121/capix-changes';
import { InvocationObservation, ObserverSession } from '@weiliang0121/capix-invocation';

for (const failure of ['isolate', 'propagate']) {
  test(`generic fact forwarding preserves typed bodies and the ${failure} session boundary`, () => {
    const type = new FactType('business.changed');
    const body = { revision: 1 };
    const fact = { contextId: 'call', offerId: 'offer', access: 'business', supplyId: 'supply', operationId: 'operation', sequence: 1, occurredAt: new Date().toISOString(), fact: type.create(body) };
    body.revision = 9;
    let attempts = 0;
    const received = [];
    const observation = new InvocationObservation(
      [
        new ObserverSession(
          {
            observe() {},
            fact() {
              attempts++;
              throw new Error('consumer failed');
            },
          },
          failure,
        ),
        new ObserverSession(
          {
            observe() {},
            fact(fact) {
              type.match(fact.fact, (body) => received.push(body));
            },
          },
          'propagate',
        ),
      ],
      new Map(),
    );
    const error = observation.facts.publish(fact);
    assert.equal(error?.code, failure === 'propagate' ? 'OBSERVATION_FAILED' : undefined);
    assert.equal(observation.facts.publish(fact), undefined);
    assert.equal(attempts, 1);
    assert.deepEqual(received, [{ revision: 1 }, { revision: 1 }]);
    assert.ok(received.every(Object.isFrozen));
  });
}
