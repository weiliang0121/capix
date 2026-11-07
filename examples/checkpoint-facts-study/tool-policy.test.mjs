import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolPolicyProbe } from './tool-policy.mjs';
import { createToolPolicyFixture } from './tool-policy-fixture.mjs';

const outcome = (run) => {
  try {
    run();
    return 'accepted';
  } catch {
    return 'rejected';
  }
};
const record = (snapshot, id) => snapshot.records.find((item) => item.identity.contextId === id);

test('incremental A/B policy agrees with unmodified public ToolLoop.check at every real policy stage', () => {
  const fixture = createToolPolicyFixture();
  const probe = new ToolPolicyProbe(fixture);
  for (const snapshot of fixture.snapshots.values()) {
    fixture.productionCheck(snapshot);
    probe.feed(snapshot);
    probe.acknowledge(probe.prepare());
    fixture.productionCheck(probe.snapshot());
  }
  assert.equal(probe.stats.fullChecks, 1);
  assert.equal(probe.stats.historicalModelAssertions, 0, 'Append-only progression does not recheck earlier certified model bodies');
  const before = { ...probe.stats };
  probe.acknowledge(probe.prepare());
  assert.equal(probe.stats.modelAssertions - before.modelAssertions, 0);
  assert.equal(probe.stats.currentQueries - before.currentQueries, 1, 'Current state is still checked without delta');
  assert.ok(probe.stats.fixtureComparisons > 0, 'Full-snapshot test adapter is counted, not sold as incremental implementation');
});

const mutations = [
  ['old prefix changed without a new relationship', 'final', (s) => (s.state.exchanges[0].id = 'different')],
  ['old prefix revision changed', 'final', (s) => s.state.exchanges[0].revision++],
  ['model reference order changed', 'final', (s) => s.refs.models.reverse()],
  ['current exchange changed', 'final', (s) => (s.state.current = { ...s.state.current, id: s.state.exchanges[0].id })],
  ['tool cursor exceeds reply', 'received-model', (s) => (s.state.cursor = 4)],
  ['active selects wrong occurrence', 'repeated-key-waiting-tool', (s) => (s.state.active.index = 0)],
  ['active names wrong call', 'waiting-tool', (s) => (s.state.active.callId = 'another')],
  ['waiting state pretends to be processing', 'next-model-waiting', (s) => (s.state.cursor = 1)],
  ['relation omitted from selected refs', 'accepted-tool', (s) => (s.refs.read = [])],
  ['tool receipt belongs to another exchange', 'accepted-tool', (s) => (record(s, 'tool-0').reception.value.reference.id = 'different')],
  ['accepted tool downgraded to pending', 'accepted-tool', (s) => (record(s, 'tool-0').reception = { status: 'pending' })],
  ['old model input changed after certification', 'final', (s) => (record(s, 'model-0').input.exchanges = [s.state.exchanges[0]])],
  ['old model receipt changed after certification', 'final', (s) => (record(s, 'model-0').reception.value.reference.id = 'different')],
  ['fixed catalog changes', 'final', (s) => (s.input.catalog = 'different')],
  ['fixed budget changes', 'final', (s) => s.input.budgets.maxReplyBytes++],
];
for (const [name, baseline, mutate] of mutations) {
  test(`oracle differential rejection: ${name}`, () => {
    const fixture = createToolPolicyFixture();
    const snapshot = fixture.snapshot(baseline);
    const probe = new ToolPolicyProbe(fixture);
    probe.feed(snapshot);
    probe.acknowledge(probe.prepare());
    mutate(snapshot);
    const expected = outcome(() => fixture.productionCheck(snapshot));
    assert.equal(expected, 'rejected');
    const actual = outcome(() => {
      probe.feed(snapshot);
      probe.prepare();
    });
    assert.equal(actual, expected);
  });
}

test('reference reorder that is valid under the actual policy stays valid', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('repeated-key-accepted-tool');
  const probe = new ToolPolicyProbe(fixture);
  probe.feed(snapshot);
  probe.acknowledge(probe.prepare());
  snapshot.refs.read.reverse();
  fixture.productionCheck(snapshot);
  probe.feed(snapshot);
  probe.acknowledge(probe.prepare());
  assert.ok(probe.stats.selectionRebuildItems > 0, 'Arbitrary reorder rebuilds author ranks explicitly');
});

test('duplicate reference occurrences do not silently become a Set or stronger coverage promise', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  snapshot.refs.read[1] = snapshot.refs.read[0];
  // The original point check only counts refs here. Cold confirmation is a
  // separate and stronger policy which rejects the omitted handled child.
  fixture.productionCheck(snapshot);
  assert.throws(() => fixture.productionConfirm(snapshot));
  const probe = new ToolPolicyProbe(fixture);
  probe.feed(snapshot);
  probe.acknowledge(probe.prepare());
});

test('check without exact acknowledgement does not consume pending certificates', () => {
  const fixture = createToolPolicyFixture();
  const probe = new ToolPolicyProbe(fixture);
  probe.feed(fixture.snapshot('final'));
  const first = probe.prepare();
  const before = probe.stats.modelAssertions;
  probe.prepare();
  assert.equal(probe.stats.modelAssertions - before, 3);
  probe.setState('completed', fixture.snapshot('final').state);
  assert.throws(() => probe.acknowledge(first), /no longer matches/);
  probe.acknowledge(probe.prepare());
});

test('failed state check does not install a partial history certificate', () => {
  const fixture = createToolPolicyFixture();
  const probe = new ToolPolicyProbe(fixture);
  const bad = fixture.snapshot('final');
  bad.state.cursor = 1;
  probe.feed(bad);
  assert.throws(() => probe.prepare());
  const before = probe.stats.modelAssertions;
  probe.setState('completed', fixture.snapshot('final').state);
  probe.acknowledge(probe.prepare());
  assert.equal(probe.stats.modelAssertions - before, 3);
});

test('cold restore performs full A again and uncertain commits cannot reuse hot proof', () => {
  const fixture = createToolPolicyFixture();
  const probe = new ToolPolicyProbe(fixture);
  probe.feed(fixture.snapshot('final'));
  probe.acknowledge(probe.prepare());
  const before = probe.stats.modelAssertions;
  probe.acknowledge(probe.prepare({ restored: true }));
  assert.equal(probe.stats.modelAssertions - before, 3);
  probe.uncertain();
  assert.throws(() => probe.prepare(), /uncertain/);
  assert.throws(() => probe.setState('completed', fixture.snapshot('final').state), /uncertain/);
  const reopened = new ToolPolicyProbe(fixture);
  reopened.feed(fixture.snapshot('final'));
  reopened.acknowledge(reopened.prepare({ restored: true }));
  assert.equal(reopened.stats.modelAssertions, 3);
});

test('explicit incremental commands need no full snapshot diff to validate an unchanged head', () => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const probe = new ToolPolicyProbe(fixture);
  probe.configure(snapshot.input, snapshot.parentId);
  for (const child of snapshot.records) probe.put(child);
  for (const [slot, refs] of Object.entries(snapshot.refs)) for (const ref of refs) probe.appendReference(slot, ref);
  for (const exchange of snapshot.state.exchanges) probe.appendExchange(exchange);
  probe.setState(snapshot.point, snapshot.state);
  probe.acknowledge(probe.prepare());
  const before = { ...probe.stats };
  probe.setState(snapshot.point, snapshot.state);
  probe.acknowledge(probe.prepare());
  assert.equal(probe.stats.fixtureComparisons, 0);
  assert.equal(probe.stats.modelAssertions - before.modelAssertions, 0);
  assert.equal(probe.stats.selectionRebuildItems, 0);
});
