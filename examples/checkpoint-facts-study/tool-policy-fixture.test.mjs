import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolPolicyFixture } from './tool-policy-fixture.mjs';

test('real ToolLoop public checkpoint policies accept serial fixture snapshots', () => {
  const fixture = createToolPolicyFixture();
  assert.equal(fixture.snapshots.size, 13);
  for (const snapshot of fixture.snapshots.values()) assert.doesNotThrow(() => fixture.productionCheck(snapshot), snapshot.name);
  assert.equal(fixture.productionConfirm(fixture.snapshot('final')), 'done');
});

test('same key across different model replies retains both exact child relationships', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const repeated = snapshot.records.filter((record) => record.key === 'reused');
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0].identity.contextId, repeated[1].identity.contextId);
  assert.doesNotThrow(() => fixture.productionConfirm(snapshot));
  repeated[1].reception.value.operation.childContextId = repeated[0].identity.contextId;
  assert.throws(() => fixture.productionConfirm(snapshot), /Feedback differs from original tool reception/);
});

test('precheck rejection persists an entity slot with no fabricated reception', () => {
  const fixture = createToolPolicyFixture();
  const before = fixture.snapshot('accepted-tool');
  const after = fixture.snapshot('rejected-precheck');
  assert.deepEqual(after.state.exchanges, before.state.exchanges);
  assert.equal(after.state.current.revision, before.state.current.revision + 1);
  assert.equal(after.records.length, before.records.length);
  const entry = fixture.restoreExchanges(after).read(after.input.scope, after.state.current);
  assert.ok(entry.feedback.some((feedback) => feedback.toolCallId === 'rejected'));
  assert.ok(!entry.receptions.some((reception) => reception.callId === 'rejected'));
});

test('stable children do not certify a subsequently edited current prefix', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.state.exchanges.reverse();
  assert.throws(() => fixture.productionCheck(snapshot), /exchange prefix/);
});

test('public confirmation preserves raw resource failures and does not wrap thrown undefined', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const failure = new Error('original reader fault');
  assert.throws(
    () =>
      fixture.productionConfirm(snapshot, {
        exchanges: {
          closed() {
            throw failure;
          },
        },
      }),
    (error) => error === failure,
  );
  let caught = false;
  try {
    fixture.productionConfirm(snapshot, {
      exchanges: {
        closed() {
          throw undefined;
        },
      },
    });
  } catch (error) {
    caught = true;
    assert.equal(error, undefined);
  }
  assert.equal(caught, true);
});

test('old intake revision is readable but cannot stand in for a closed exact prefix', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const entity = fixture.restoreExchanges(snapshot);
  const initial = snapshot.records.find((record) => record.identity.contextId === 'model-0').reception.value.reference;
  assert.equal(initial.revision, 0);
  assert.equal(entity.read(snapshot.input.scope, initial, false).revision, 3);
  assert.throws(() => entity.closed(snapshot.input.scope, [initial]), /revision mismatch/);
});
