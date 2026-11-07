import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolPolicyFixture } from './tool-policy-fixture.mjs';

// These tests call the two real author-policy boundaries separately. A callback
// accepting a snapshot does not establish full Invocation/host restore eligibility.
const record = (snapshot, id) => snapshot.records.find((item) => item.identity.contextId === id);
function resources(fixture, snapshot, changeRead = (entry) => entry) {
  const entity = fixture.restoreExchanges(snapshot);
  return {
    closed: (references) => entity.closed(snapshot.input.scope, references),
    read: (reference) => changeRead(entity.read(snapshot.input.scope, reference, false), reference),
  };
}

test('changed old prefix requires author check even when all external entries remain valid', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.state.exchanges.reverse();
  assert.throws(() => fixture.productionCheck(snapshot), /exchange prefix/);
  // closed() authenticates each selected exchange, not the author's prefix order.
  assert.equal(fixture.productionConfirm(snapshot), 'done');
});

test('reordered model occurrences change both prefix and tool interval interpretation', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  [snapshot.refs.models[0], snapshot.refs.models[1]] = [snapshot.refs.models[1], snapshot.refs.models[0]];
  assert.throws(() => fixture.productionCheck(snapshot), /fixed exchange prefix/);
  assert.throws(() => fixture.productionConfirm(snapshot), /Feedback has no exact tool child/);
});

test('current selection, cursor and active slot require rechecking without any new child', () => {
  const fixture = createToolPolicyFixture();
  const cases = [
    [
      'final',
      (snapshot) => {
        snapshot.state.current = snapshot.state.exchanges[0];
      },
      /Current exchange differs/,
    ],
    [
      'final',
      (snapshot) => {
        snapshot.state.cursor = 1;
      },
      /cursor exceeds/,
    ],
    [
      'repeated-key-waiting-tool',
      (snapshot) => {
        snapshot.state.active.index = 0;
      },
      /Active tool differs/,
    ],
  ];
  for (const [name, change, expected] of cases) {
    const snapshot = fixture.snapshot(name);
    const originalRecords = structuredClone(snapshot.records);
    change(snapshot);
    assert.deepEqual(snapshot.records, originalRecords, 'Only the current state was changed');
    assert.throws(() => fixture.productionCheck(snapshot), expected);
  }
});

test('missing exact tool is rejected by count or external confirmation, depending on missing evidence', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.refs.read = snapshot.refs.read.filter((reference) => reference.contextId !== 'tool-0');
  assert.throws(() => fixture.productionCheck(snapshot), /omitted child relations/);
  assert.throws(() => fixture.productionConfirm(snapshot), /Feedback has no exact tool child/);
  // A matching count alone cannot recreate a missing historical tool relation.
  snapshot.records = snapshot.records.filter((item) => item.identity.contextId !== 'tool-0');
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  assert.throws(() => fixture.productionConfirm(snapshot), /Feedback has no exact tool child/);
});

test('persisted tool feedback with a pending parent reception is not rejected by the confirmation closure', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const child = record(snapshot, 'tool-0');
  child.reception = { status: 'pending' };
  assert.ok(snapshot.exchanges.entries[0].feedback.some((feedback) => feedback.toolCallId === child.key));
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  assert.equal(fixture.productionConfirm(snapshot), 'done');
  // This documents confirmExchanges' unfinished-reception branch, not a claim
  // that this artificial completed head passes the full recovery qualifier.
});

test('external reply must equal the fixed model return even when local author check passes', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const exchangeResources = resources(fixture, snapshot, (entry) => (entry.id === snapshot.state.exchanges[0].id ? { ...entry, reply: { ...entry.reply, id: 'different-reply' } } : entry));
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  assert.throws(() => fixture.productionConfirm(snapshot, { exchanges: exchangeResources }), /Exchange differs from original model return or reception/);
});

test('successful and handled receipts require exact external feedback digests', () => {
  const fixture = createToolPolicyFixture();
  for (const childId of ['tool-0', 'tool-1']) {
    const snapshot = fixture.snapshot('final');
    record(snapshot, childId).reception.value.feedbackDigest = '0'.repeat(64);
    assert.doesNotThrow(() => fixture.productionCheck(snapshot));
    assert.throws(() => fixture.productionConfirm(snapshot), /Feedback differs from original tool reception/);
  }
});

test('model and tool operation ownership are separately confirmed against external facts', () => {
  const fixture = createToolPolicyFixture();
  for (const kind of ['model', 'tool']) {
    const snapshot = fixture.snapshot('final');
    const exchangeResources = resources(fixture, snapshot, (entry) => {
      if (entry.id !== snapshot.state.exchanges[0].id) return entry;
      if (kind === 'model') return { ...entry, operation: { ...entry.operation, parentContextId: 'foreign-parent' } };
      return { ...entry, receptions: entry.receptions.map((item) => (item.callId === 'reused' ? { ...item, operation: { ...item.operation, childContextId: 'foreign-child' } } : item)) };
    });
    assert.doesNotThrow(() => fixture.productionCheck(snapshot));
    assert.throws(() => fixture.productionConfirm(snapshot, { exchanges: exchangeResources }), kind === 'model' ? /Exchange differs from original model return or reception/ : /Feedback differs from original tool reception/);
  }
});

test('foreign collection is not repaired by matching exchange identity or local history', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.state.exchanges[0].collection = 'foreign-collection';
  assert.throws(() => fixture.productionCheck(snapshot), /exchange prefix/);
  assert.throws(() => fixture.productionConfirm(snapshot), /scope or revision mismatch/);
});

test('missing durable exchange is detected independently of valid call facts', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.exchanges = { ...snapshot.exchanges, sequence: 0, entries: [] };
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  assert.throws(() => fixture.productionConfirm(snapshot), /scope or revision mismatch/);
});

test('a same-key same-input child outside the original model interval is insufficient', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  record(snapshot, 'tool-2').order = record(snapshot, 'tool-0').order;
  record(snapshot, 'tool-2').identity.order = record(snapshot, 'tool-0').identity.order;
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  assert.throws(() => fixture.productionConfirm(snapshot), /Feedback has no exact tool child/);
});

test('precheck feedback with no child still has to match the fixed policy', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const exchangeResources = resources(fixture, snapshot, (entry) => ({ ...entry, feedback: entry.feedback.map((feedback) => (feedback.toolCallId === 'rejected' ? { ...feedback, content: [{ kind: 'text', text: 'different rejection policy' }] } : feedback)) }));
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  assert.throws(() => fixture.productionConfirm(snapshot, { exchanges: exchangeResources }), /Precheck feedback differs from fixed policy/);
});

test('cold confirmation preserves thrown undefined from a reader after prefix validation', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const exchangeResources = resources(fixture, snapshot, () => {
    throw undefined;
  });
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  let caught = false;
  try {
    fixture.productionConfirm(snapshot, { exchanges: exchangeResources });
  } catch (error) {
    caught = true;
    assert.equal(error, undefined);
  }
  assert.equal(caught, true);
});

test('baseline count-only author check permits duplicate occurrence masking an omitted old tool', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.refs.read[2] = structuredClone(snapshot.refs.read[1]);
  assert.equal(
    Object.values(snapshot.refs).reduce((sum, references) => sum + references.length, 0),
    snapshot.records.length,
  );
  assert.doesNotThrow(() => fixture.productionCheck(snapshot));
  assert.throws(() => fixture.productionConfirm(snapshot), /Feedback has no exact tool child/);
  // Keep this baseline visible; a candidate must not call a stronger unique-set
  // check equivalent, nor infer that this is accepted by all kernel validators.
});

test('closed historical prefix needs exact revision even though intake receipts read latest', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.state.exchanges[0] = structuredClone(record(snapshot, 'model-0').reception.value.reference);
  assert.throws(() => fixture.productionCheck(snapshot), /fixed exchange prefix/);
  assert.throws(() => fixture.productionConfirm(snapshot), /scope or revision mismatch/);
});
