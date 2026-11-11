import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { ChangeCaptureError, ChangeBuffer } from '@weiliang0121/capix-changes';

import { Resource, Resources } from '@weiliang0121/capix-resources';

import { Transcript } from '@weiliang0121/capix-transcript';

import { Memories, MemoryFacts, MemoryResource } from '@weiliang0121/capix-memory';

const create = (content) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });

const fixedRequest = (memories, input, contextId = 'content-host') => ({ contract: { key: 'memories.apply', version: 1 }, operation: { contextId, position: input.position }, memoriesId: memories.id, changes: input.changes });

const failures = { isProtected: (error) => error instanceof RuntimeError, isCancellation: () => false, describe: (error) => ({ message: error.message }) };

const owner = (extra = {}) => ({ contextId: 'content-host', failures, validate() {}, ...extra });

const memoryBinding = (memories) => new Resources().register(new Resource(memories), MemoryResource.apply).bind({ memory: MemoryResource.apply.request() });

test('memory storage failure is classified by the entity and crosses the offer without installing content or a receipt', () => {
  const transcript = new Transcript([{ role: 'user', content: 'input' }]);
  const cause = new Error('storage unavailable');
  const changes = new ChangeBuffer();
  let reject = true;
  const writes = [];
  const memories = new Memories(transcript, {
    changes,
    persistence: {
      commit(change) {
        if (reject) throw cause;
        writes.push(change);
      },
    },
  });
  const reported = [];
  const access = memoryBinding(memories).open(
    owner({
      error: (error) => {
        reported.push(error);
      },
    }),
  );
  try {
    const input = { position: 'remember', changes: [create('remembered')] };
    let failure;
    assert.throws(
      () => access.endpoints.memory.applyFixed(input),
      (error) => {
        failure = error;
        return error instanceof PersistenceError && error.operation === 'memories.commit' && error.cause === cause;
      },
    );
    assert.equal(memories.sequence, 0);
    assert.deepEqual(memories.values(), []);
    assert.equal(memories.confirmFixed(fixedRequest(memories, input)), undefined);
    assert.equal(changes.size, 0);
    assert.ok(reported.includes(failure));
    reject = false;
    const receipt = access.endpoints.memory.applyFixed(input);
    assert.equal(receipt.sequence, 1);
    assert.equal(writes.length, 1);
    assert.equal(changes.size, 1);
  } finally {
    access.close();
  }
});

test('post-commit capture failure retains shared error identity and can confirm the fixed result without replay', () => {
  const transcript = new Transcript([{ role: 'user', content: 'input' }]);
  const cause = new Error('capture unavailable');
  const writes = [];
  const events = [];
  const observed = [];
  const memories = new Memories(transcript, {
    persistence: {
      commit: (change) => {
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
  const reported = [];
  const access = memoryBinding(memories).open(
    owner({
      facts: {
        publish: (fact) => {
          assert.equal(fact.contextId, 'content-host');
          assert.equal(
            MemoryFacts.match(fact.fact, (event) => observed.push(event)),
            true,
          );
        },
      },
      error: (error) => {
        reported.push(error);
      },
    }),
  );
  const input = { position: 'remember', changes: [create('remembered')] };
  try {
    let failure;
    assert.throws(
      () => access.endpoints.memory.applyFixed(input),
      (error) => {
        failure = error;
        return error instanceof ChangeCaptureError && error instanceof RuntimeError && error.code === 'CHANGE_CAPTURE_FAILED' && error.cause === cause;
      },
    );
    assert.ok(reported.includes(failure));
    assert.equal(failure.event, events[0]);
    assert.deepEqual(observed[0], events[0], 'optional observation still receives the fixed committed fact');
    assert.ok(Object.isFrozen(observed[0].change.result));
    assert.equal(events[0].origin.contextId, 'content-host');
    assert.equal(memories.sequence, 1);
    const receipt = access.endpoints.memory.applyFixed(input);
    assert.equal(receipt, memories.confirmFixed(fixedRequest(memories, input)));
    assert.equal(writes.length, 1);
    assert.equal(events.length, 1);
    assert.equal(observed.length, 1, 'confirming an old effect does not publish a second change');
    const restoredTranscript = Transcript.restore(transcript.exportState());
    const restored = Memories.restore(memories.exportState(), restoredTranscript, {
      persistence: {
        commit() {
          assert.fail('fixed result must not be written again');
        },
      },
    });
    const recovery = memoryBinding(restored).open(owner());
    try {
      assert.deepEqual(recovery.endpoints.memory.applyFixed(input), receipt);
      assert.equal(restored.values()[0].transcript, restoredTranscript);
    } finally {
      recovery.close();
    }
  } finally {
    access.close();
  }
});
