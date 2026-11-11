import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { ChangeCaptureError } from '@weiliang0121/capix-changes';
import { Resource, Resources } from '@weiliang0121/capix-resources';
import { Memories, MemoryFacts, memoryResources } from '@weiliang0121/capix-memory';
import { create, fixed } from './support.mjs';

const failures = { isProtected: (error) => error instanceof RuntimeError, isCancellation: () => false, describe: () => ({ message: 'failed' }) };
function accessFor(memories, extra = {}) {
  const offers = memoryResources();
  return new Resources()
    .register(new Resource(memories), offers.apply)
    .bind({ memory: offers.apply.request() })
    .open({ contextId: 'memory-test-call', failures, validate() {}, ...extra });
}

test('entity persistence failure crosses resource as protected and does not grant retry on the uncertain instance', () => {
  const cause = new Error('commit result unknown');
  let writes = 0;
  const memories = new Memories({
    persistence: {
      commit() {
        writes++;
        throw cause;
      },
    },
  });
  const before = memories.snapshot();
  const reported = [];
  const access = accessFor(memories, {
    error: (error) => {
      reported.push(error);
    },
  });
  try {
    assert.throws(
      () => access.endpoints.memory.apply([create('candidate')]),
      (error) => error instanceof PersistenceError && error.cause === cause,
    );
    assert.ok(reported.some((error) => error instanceof PersistenceError));
    assert.deepEqual(before.items, []);
    assert.throws(() => access.endpoints.memory.apply([]), PersistenceError);
    assert.equal(writes, 1);
  } finally {
    access.close();
  }
});

test('post-commit capture error retains identity and confirms the old effect without republishing', () => {
  const cause = new Error('capture unavailable');
  const writes = [];
  const events = [];
  const observed = [];
  const memories = new Memories({
    persistence: {
      commit(change) {
        writes.push(change);
      },
    },
    changes: {
      capture(event) {
        events.push(event);
        throw cause;
      },
    },
  });
  const access = accessFor(memories, {
    facts: {
      publish(fact) {
        assert.equal(
          MemoryFacts.match(fact.fact, (event) => {
            observed.push(event);
          }),
          true,
        );
      },
    },
  });
  const input = { position: 'remember', changes: [create('remembered')] };
  try {
    assert.throws(
      () => access.endpoints.memory.applyFixed(input),
      (error) => error instanceof ChangeCaptureError && error.cause === cause && error.event === events[0],
    );
    assert.equal(memories.sequence, 1);
    assert.deepEqual(observed, events);
    const receipt = access.endpoints.memory.applyFixed(input);
    assert.equal(receipt, memories.confirmFixed(fixed(memories, input.changes)));
    assert.equal(writes.length, 1);
    assert.equal(events.length, 1);
    assert.equal(observed.length, 1);
    const restored = Memories.restore(memories.exportState(), {
      persistence: {
        commit() {
          assert.fail('known effect cannot be rewritten');
        },
      },
    });
    const recovery = accessFor(restored);
    try {
      assert.deepEqual(recovery.endpoints.memory.applyFixed(input), receipt);
    } finally {
      recovery.close();
    }
  } finally {
    access.close();
  }
});
