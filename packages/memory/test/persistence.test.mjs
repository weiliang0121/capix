import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeBuffer, ChangeCaptureError } from '@weiliang0121/capix-changes';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { stableValue, StableValueError } from '@weiliang0121/capix-contracts';
import { Memories } from '@weiliang0121/capix-memory';
import { create, update, fixed } from './support.mjs';

test('a complete batch commits once before installation and all notifications see the final collection', () => {
  let memories;
  const writes = [];
  const observed = [];
  memories = new Memories({
    persistence: {
      commit(change) {
        assert.equal(memories.sequence, change.expectedSequence);
        assert.equal(memories.values().length, 0);
        writes.push(change);
      },
    },
    changes: {
      capture(event) {
        observed.push(event);
        assert.equal(memories.sequence, 2);
        assert.equal(memories.values().length, 2);
      },
    },
  });
  const applied = memories.apply([create('one'), create('two')]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].upserts, applied.changed);
  assert.deepEqual(
    observed.map((event) => event.sequence),
    [1, 2],
  );
  assert.ok(Object.isFrozen(writes[0]));
  assert.ok(Object.isFrozen(applied.changed));
  assert.deepEqual(memories.snapshot().items, applied.changed);
});

test('current-format restoration is silent and preserves IDs, order, content and fixed receipts', () => {
  const memories = new Memories();
  const request = fixed(memories, [create('one'), create('two')]);
  const receipt = memories.applyFixed(request);
  const [first, second] = memories.values();
  memories.apply([update(first.id, 'revised')]);
  const saved = memories.exportState();
  const restored = Memories.restore(saved, {
    persistence: {
      commit() {
        assert.fail('restore/confirm must not commit');
      },
    },
    changes: {
      capture() {
        assert.fail('restore/confirm must not publish');
      },
    },
  });
  assert.deepEqual(restored.exportState(), saved);
  assert.deepEqual(
    restored.values().map((item) => item.id),
    [first.id, second.id],
  );
  assert.deepEqual(restored.confirmFixed(request), receipt);
  assert.deepEqual(restored.applyFixed(request), receipt);
  assert.equal(restored.read(first.id).value.content, 'revised');
});

test('fixed no-op persists a receipt once while reason participates only in request identity', () => {
  const commits = [];
  const events = new ChangeBuffer();
  const memories = new Memories({
    changes: events,
    persistence: {
      commit(value) {
        commits.push(value);
      },
    },
  });
  const empty = fixed(memories, []);
  const receipt = memories.applyFixed(empty);
  assert.equal(commits.length, 1);
  assert.equal(memories.sequence, 0);
  assert.deepEqual(receipt.changes, []);
  assert.equal(memories.applyFixed(empty), receipt);
  const item = memories.apply([create('same')]).changed[0];
  const noopChanges = [{ ...update(item.id, 'same'), reason: 'new explanation' }];
  const noop = fixed(memories, noopChanges, { operation: { contextId: 'call' }, command: { position: 'noop', changes: noopChanges }, expected: memories.snapshot().basis });
  const before = commits.length;
  const confirmed = memories.applyFixed(noop);
  assert.equal(commits.length, before + 1);
  assert.equal(confirmed.startSequence, confirmed.sequence);
  assert.deepEqual(confirmed.changes, []);
  memories.apply([update(item.id, 'later')]);
  assert.equal(memories.applyFixed(noop), confirmed, 'confirmation uses the original basis');
  assert.throws(() => memories.confirmFixed({ ...noop, command: { ...noop.command, changes: [{ ...noop.command.changes[0], reason: 'different' }] } }));
  assert.equal(events.size, 2);
});

test('lost commit acknowledgement blocks new work and unknown confirmation but preserves prior material and receipts', () => {
  const writes = [];
  let reject = false;
  const cause = new Error('acknowledgement lost');
  const memories = new Memories({
    persistence: {
      commit(change) {
        writes.push(change);
        if (reject) throw cause;
      },
    },
  });
  const oldRequest = fixed(memories, [create('known')]);
  const oldReceipt = memories.applyFixed(oldRequest);
  const oldRead = memories.read(oldReceipt.changes[0].memoryId);
  const savedBefore = memories.exportState();
  reject = true;
  const uncertainChanges = [create('external effect')];
  const uncertain = fixed(memories, uncertainChanges, { operation: { contextId: 'call' }, command: { position: 'uncertain', changes: uncertainChanges } });
  assert.throws(
    () => memories.applyFixed(uncertain),
    (error) => error instanceof PersistenceError && error.cause === cause,
  );
  assert.equal(memories.confirmFixed(oldRequest), oldReceipt);
  for (const access of [() => memories.apply([]), () => memories.applyFixed(uncertain), () => memories.confirmFixed(uncertain), () => memories.read(oldRead.id), () => memories.values(), () => memories.snapshot(), () => memories.exportState()]) assert.throws(access, PersistenceError);
  assert.equal(oldRead.value.content, 'known');
  assert.equal(writes.length, 2);
  const committed = writes[1];
  const authoritative = { ...savedBefore, sequence: committed.sequence, items: [...savedBefore.items, ...committed.upserts], applies: [...savedBefore.applies, committed.fixed] };
  const reloaded = Memories.restore(authoritative);
  assert.deepEqual(reloaded.confirmFixed(uncertain), committed.fixed.receipt);
  assert.equal(reloaded.values().length, 2);
});

test('post-commit publication failure preserves the entire batch and attempts all fact deliveries', () => {
  const events = [];
  const observed = [];
  const memories = new Memories({
    changes: {
      capture(event) {
        events.push(event);
        if (event.sequence === 1) throw new Error('capture');
      },
    },
    observation: {
      publish(event) {
        observed.push(event);
      },
    },
  });
  const request = fixed(memories, [create('one'), create('two')]);
  assert.throws(() => memories.applyFixed(request), ChangeCaptureError);
  assert.equal(memories.sequence, 2);
  assert.equal(memories.values().length, 2);
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2],
  );
  assert.deepEqual(observed, events);
  const receipt = memories.confirmFixed(request);
  assert.equal(memories.applyFixed(request), receipt);
  assert.equal(events.length, 2);
});

test('prepared result and event capacity is checked before external persistence', () => {
  let writes = 0;
  const memories = new Memories({
    persistence: {
      commit() {
        writes++;
      },
    },
  });
  let metadata = 'leaf';
  for (let depth = 0; depth < 64; depth++) metadata = { child: metadata };
  assert.throws(() => memories.apply([create('deep', metadata)]));
  assert.equal(writes, 0);
  assert.equal(memories.sequence, 0);
});

test('complete fixed commit capacity is checked even when its individual request and result fit', () => {
  let metadata = 'leaf';
  for (let depth = 0; depth < 18; depth++) metadata = [metadata, metadata];
  let writes = 0;
  const memories = new Memories({
    persistence: {
      commit() {
        writes++;
      },
    },
  });
  const request = fixed(memories, [create('shared metadata', metadata)]);
  assert.doesNotThrow(() => stableValue(request));
  const plain = new Memories();
  assert.equal(plain.apply(request.command.changes).changed.length, 1, 'the ordinary result also fits');
  assert.throws(
    () => memories.applyFixed(request),
    (error) => error instanceof StableValueError && error.code === 'VALUE_LIMIT',
  );
  assert.equal(writes, 0);
  assert.equal(memories.sequence, 0);
  assert.deepEqual(memories.values(), []);
  assert.equal(memories.confirmFixed(request), undefined);
});
