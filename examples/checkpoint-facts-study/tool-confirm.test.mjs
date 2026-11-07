import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexedToolConfirm } from './tool-confirm.mjs';
import { createToolPolicyFixture } from './tool-policy-fixture.mjs';

function outcome(run) {
  try {
    return { status: 'succeeded', value: run() };
  } catch (error) {
    return { status: 'failed', name: error.name, message: error.message, code: error.code };
  }
}

function compare(fixture, snapshot, resource) {
  const actual = outcome(() => indexedToolConfirm(fixture, snapshot, { resource }));
  const expected = outcome(() => fixture.productionConfirm(snapshot, resource ? { exchanges: resource } : {}));
  assert.deepEqual(actual, expected);
  return actual;
}

function patchResource(fixture, snapshot, patch) {
  const entity = fixture.restoreExchanges(snapshot);
  return {
    closed: (references) => entity.closed(snapshot.input.scope, references),
    read(reference) {
      const entry = structuredClone(entity.read(snapshot.input.scope, reference, false));
      patch(entry);
      return entry;
    },
  };
}

test('indexed confirmation agrees with actual production completed.resume on every fixture snapshot', () => {
  const fixture = createToolPolicyFixture();
  for (const name of fixture.snapshots.keys()) compare(fixture, fixture.snapshot(name));
  assert.deepEqual(compare(fixture, fixture.snapshot('final')), { status: 'succeeded', value: 'done' });
});

test('cold confirmation reports full rebuild and lookup work separately', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const stats = {};
  assert.equal(indexedToolConfirm(fixture, snapshot, { stats }), 'done');
  assert.equal(stats.indexRebuildRecords, 6);
  assert.equal(stats.rankReferences, 6);
  assert.equal(stats.modelRelations, 3);
  assert.equal(stats.entityReads, 4);
  assert.equal(stats.feedbackItems, 4);
  assert.equal(stats.lookupQueries, 3);
  assert.equal(stats.lookupCandidates, 3);
  assert.equal(stats.inputComparisons, 3);
  assert.equal(stats.receptionLookups, 3);
});

test('reused tool IDs require the exact model order interval and selected input', () => {
  const fixture = createToolPolicyFixture();
  for (const change of [
    (snapshot) => (snapshot.records.find((record) => record.identity.contextId === 'tool-2').input.path = 'other.txt'),
    (snapshot) => (snapshot.refs.read = snapshot.refs.read.filter((ref) => ref.contextId !== 'tool-2')),
    (snapshot) => {
      const child = snapshot.records.find((record) => record.identity.contextId === 'tool-2');
      child.order = 3;
      child.identity.order = 3;
    },
  ]) {
    const snapshot = fixture.snapshot('final');
    change(snapshot);
    const result = compare(fixture, snapshot);
    assert.equal(result.status, 'failed');
    assert.match(result.message, /exact tool child/);
  }
});

test('author order, duplicate occurrences and missing selection preserve production find semantics', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  // Add a distinct later child in the first model interval. Its receipt is bad.
  // Scale order to leave integer room without changing existing relationships.
  for (const record of snapshot.records) {
    record.order *= 10;
    record.identity.order *= 10;
  }
  const original = snapshot.records.find((record) => record.identity.contextId === 'tool-0');
  const duplicate = structuredClone(original);
  duplicate.identity.contextId = 'same-key-other-child';
  duplicate.identity.order = 11;
  duplicate.order = 11;
  duplicate.ref.contextId = duplicate.identity.contextId;
  duplicate.reception.value.feedbackDigest = 'a'.repeat(64);
  snapshot.records.push(duplicate);
  snapshot.refs.read.push(duplicate.ref);
  assert.equal(compare(fixture, snapshot).status, 'succeeded');
  snapshot.refs.read.unshift(duplicate.ref);
  const rejected = compare(fixture, snapshot);
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.message, /original tool reception/);
  snapshot.refs.read = snapshot.refs.read.filter((ref) => ref.contextId !== duplicate.ref.contextId);
  snapshot.refs.read.unshift(original.ref, original.ref);
  assert.equal(compare(fixture, snapshot).status, 'succeeded');
});

test('persisted feedback does not require parent acceptance already present', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  // This isolates confirmExchanges' responsibility, not whole-CP eligibility.
  // A separate point.check still decides whether the surrounding state is valid.
  for (const record of snapshot.records) if (record.identity.position === 1) record.reception = { status: 'pending' };
  assert.deepEqual(compare(fixture, snapshot), { status: 'succeeded', value: 'done' });
});

test('model return and original model operation cannot be replaced by current entity data', () => {
  const fixture = createToolPolicyFixture();
  for (const change of [(snapshot) => (snapshot.records[0].returned.output.model = 'changed'), (snapshot) => (snapshot.records[0].reception.value.operation.childContextId = 'different-model'), (snapshot) => (snapshot.records[0].returned = { status: 'failed', diagnostic: {} })]) {
    const snapshot = fixture.snapshot('final');
    change(snapshot);
    const rejected = compare(fixture, snapshot);
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.message, /original model return or reception/);
  }
});

test('accepted and handled feedback both retain collection, ID, digest and operation checks', () => {
  const fixture = createToolPolicyFixture();
  for (const id of ['tool-0', 'tool-1']) {
    for (const change of [(receipt) => (receipt.reference.collection = 'wrong'), (receipt) => (receipt.reference.id = 'wrong'), (receipt) => (receipt.feedbackDigest = 'a'.repeat(64)), (receipt) => (receipt.operation.childContextId = 'wrong')]) {
      const snapshot = fixture.snapshot('final');
      const child = snapshot.records.find((record) => record.identity.contextId === id);
      child.reception.value = structuredClone(child.reception.value);
      change(child.reception.value);
      const rejected = compare(fixture, snapshot);
      assert.equal(rejected.status, 'failed');
      assert.match(rejected.message, /original tool reception/);
    }
  }
});

test('precheck feedback and orphan feedback stay rejected by the same production checks', () => {
  const fixture = createToolPolicyFixture();
  for (const patch of [
    (entry) => {
      const feedback = entry.feedback.find((item) => item.toolCallId === 'rejected');
      if (feedback) feedback.content[0].text = 'different precheck policy';
    },
    (entry) => {
      if (entry.feedback.length) entry.feedback[0].toolCallId = 'no-original-call';
    },
  ]) {
    const snapshot = fixture.snapshot('final');
    assert.equal(compare(fixture, snapshot, patchResource(fixture, snapshot, patch)).status, 'failed');
  }
});

test('original reply and feedback byte ceilings remain enforced before accepting durable records', () => {
  const fixture = createToolPolicyFixture();
  for (const [patch, code] of [
    [
      (entry) => {
        if (entry.reply.output[0]?.kind === 'text') entry.reply.output[0].text = 'x'.repeat(fixture.loop.budgets.maxReplyBytes);
        else entry.reply.output.unshift({ kind: 'text', text: 'x'.repeat(fixture.loop.budgets.maxReplyBytes) });
      },
      'TOOL_REPLY_LIMIT',
    ],
    [
      (entry) => {
        if (entry.feedback.length) entry.feedback[0].content = [{ kind: 'text', text: 'x'.repeat(fixture.loop.budgets.maxFeedbackBytes) }];
      },
      'TOOL_FEEDBACK_LIMIT',
    ],
  ]) {
    const snapshot = fixture.snapshot('final');
    const rejected = compare(fixture, snapshot, patchResource(fixture, snapshot, patch));
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.code, code);
  }
});

test('tool output byte bound is checked even before the parent has accepted that output', () => {
  const fixture = createToolPolicyFixture({ maxOutputBytes: 16 });
  const snapshot = fixture.snapshot('final');
  const rejected = compare(fixture, snapshot);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.code, 'TOOL_OUTPUT_LIMIT');
  snapshot.records.find((record) => record.identity.contextId === 'tool-0').reception = { status: 'pending' };
  assert.equal(compare(fixture, snapshot).code, 'TOOL_OUTPUT_LIMIT');
});

test('exact closed prefix validation remains delegated to the real exchange entity', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.state.exchanges[0].revision--;
  assert.equal(compare(fixture, snapshot).status, 'failed');
});
