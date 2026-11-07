import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { SavedFacts } from './saved-facts.mjs';
import { createSavedToolPolicy, toolPolicyTimeline } from './saved-facts-policy.mjs';
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
const difference = (current, previous) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value - previous[key]]));

for (const [name] of toolPolicyTimeline) {
  test(`real ToolLoop policy consumes call-owned saved facts at ${name}`, (t) => {
    const fixture = createToolPolicyFixture();
    const snapshot = fixture.snapshot(name);
    const probe = createSavedToolPolicy(fixture, snapshot);
    t.after(probe.close);
    assert.equal(
      outcome(() => fixture.productionCheck(snapshot)),
      'accepted',
    );
    assert.doesNotThrow(() => probe.save(snapshot.point, snapshot.state));
    assert.equal(probe.loading.coldRelations, snapshot.records.length);
    assert.equal(
      probe.loading.coldReferenceOccurrences,
      Object.values(snapshot.refs).reduce((total, refs) => total + refs.length, 0),
    );
    assert.equal(probe.facts.stats.wrappersBuilt, snapshot.records.length, 'The unchanged author check explicitly enumerates every relation');
    assert.equal(probe.facts.stats.enumerationItems, snapshot.records.length);
  });
}

test('one call advances through all thirteen real policy stages without a snapshot diff or reimport', (t) => {
  const fixture = createToolPolicyFixture();
  const probe = createSavedToolPolicy(fixture, fixture.snapshot('waiting-model'));
  t.after(probe.close);
  // Fixture lookup is preparation, not part of save or the facts query facade.
  const commands = toolPolicyTimeline.map(([name, command, id]) => {
    const snapshot = fixture.snapshot(name);
    return { snapshot, command, changed: id === null ? null : record(snapshot, id) };
  });
  for (const { snapshot, command, changed } of commands) {
    fixture.productionCheck(snapshot);
    if (command) probe[command](changed);
    probe.save(snapshot.point, snapshot.state);
  }
  assert.deepEqual(probe.loading, { coldRelations: 1, coldReferenceOccurrences: 1, coldSettlements: 0, hotAppends: 5, hotSettlements: 6, explicitReferenceRewrites: 0 });
  assert.equal(probe.call.stats.establishmentCheck, 6);
  assert.equal(probe.call.stats.receptionEncode, 6);
  assert.equal(probe.call.stats.persistenceCheck, 6);
  assert.equal(probe.facts.stats.baselineValidations, 1);
  assert.equal(probe.facts.stats.authorChecks, 13);

  const beforeCall = { ...probe.call.stats };
  const beforeFacts = { ...probe.facts.stats };
  const beforeLedger = { ...probe.call.factStats };
  const final = fixture.snapshot('final');
  probe.save(final.point, final.state);
  assert.equal(probe.call.stats.receptionEncode - beforeCall.receptionEncode, 0);
  assert.equal(probe.call.stats.persistenceCheck - beforeCall.persistenceCheck, 0);
  assert.equal(probe.call.factStats.encodedFacts - beforeLedger.encodedFacts, 0);
  assert.equal(probe.facts.stats.referenceValidationItems - beforeFacts.referenceValidationItems, 0, 'Unchanged selections are not authenticated by scanning old occurrences');
  assert.equal(probe.facts.stats.enumerationItems - beforeFacts.enumerationItems, 6, 'Actual point.check still requests all relations');
  assert.equal(probe.facts.stats.wrappersBuilt - beforeFacts.wrappersBuilt, 6);
  assert.equal(probe.facts.stats.bodyReads - beforeFacts.bodyReads, 19, 'Author consumption is not hidden as zero-cost mechanism reuse');
});

const mutations = [
  ['old prefix id', 'final', (s) => (s.state.exchanges[0].id = 'different')],
  ['old prefix revision', 'final', (s) => s.state.exchanges[0].revision++],
  ['model reference order', 'final', (s) => s.refs.models.reverse()],
  ['current exchange', 'final', (s) => (s.state.current = { ...s.state.current, id: s.state.exchanges[0].id })],
  ['cursor past the reply', 'received-model', (s) => (s.state.cursor = 4)],
  ['active wrong occurrence', 'repeated-key-waiting-tool', (s) => (s.state.active.index = 0)],
  ['active wrong call key', 'waiting-tool', (s) => (s.state.active.callId = 'another')],
  ['waiting state with a processing cursor', 'next-model-waiting', (s) => (s.state.cursor = 1)],
  ['omitted tool reference', 'accepted-tool', (s) => (s.refs.read = [])],
  ['receipt from another exchange', 'accepted-tool', (s) => (record(s, 'tool-0').reception.value.reference.id = 'different')],
  ['returned tool without reception', 'accepted-tool', (s) => (record(s, 'tool-0').reception = { status: 'pending' })],
  ['old model input', 'final', (s) => (record(s, 'model-0').input.exchanges = [s.state.exchanges[0]])],
  ['old model receipt', 'final', (s) => (record(s, 'model-0').reception.value.reference.id = 'different')],
  ['fixed catalog', 'final', (s) => (s.input.catalog = 'different')],
  ['fixed budget', 'final', (s) => s.input.budgets.maxReplyBytes++],
  ['unknown selected child', 'final', (s) => (s.refs.read[0] = { contextId: 'absent' })],
  ['model selected as a tool', 'waiting-tool', (s) => (s.refs.read[0] = s.refs.models[0])],
  ['foreign child owner', 'waiting-tool', (s) => (record(s, 'model-0').identity.parentId = 'foreign')],
  ['unknown point', 'final', (s) => (s.point = 'missing')],
];

for (const [name, baseline, mutate] of mutations) {
  test(`point-policy differential rejects ${name}`, () => {
    const fixture = createToolPolicyFixture();
    const snapshot = fixture.snapshot(baseline);
    mutate(snapshot);
    const expected = outcome(() => fixture.productionCheck(snapshot));
    assert.equal(expected, 'rejected');
    const actual = outcome(() => {
      const probe = createSavedToolPolicy(fixture, snapshot);
      try {
        probe.save(snapshot.point, snapshot.state);
      } finally {
        probe.close();
      }
    });
    assert.equal(actual, expected);
  });
}

test('a hot state-only change is checked against old facts even without any new relation', (t) => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const probe = createSavedToolPolicy(fixture, snapshot);
  t.after(probe.close);
  probe.save(snapshot.point, snapshot.state);
  const before = { ...probe.call.stats };
  snapshot.state.exchanges[0].revision++;
  assert.throws(() => fixture.productionCheck(snapshot));
  assert.throws(() => probe.save(snapshot.point, snapshot.state));
  assert.equal(probe.call.stats.receptionEncode - before.receptionEncode, 0);
  assert.equal(probe.call.stats.persistenceCheck - before.persistenceCheck, 0);
});

test('all three production point names keep their shared policy; switching point is not inferred resume eligibility', (t) => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('accepted-tool');
  const probe = createSavedToolPolicy(fixture, snapshot);
  t.after(probe.close);
  for (const point of fixture.points.keys()) {
    assert.equal(
      outcome(() => probe.check(point, snapshot.state)),
      outcome(() => fixture.productionCheck(snapshot, point)),
    );
  }
  assert.throws(() => probe.check('unknown', snapshot.state));
});

test('explicit hot reference edits preserve order, duplicates and the actual policy rejection boundary', (t) => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const probe = createSavedToolPolicy(fixture, snapshot);
  t.after(probe.close);
  probe.save(snapshot.point, snapshot.state);

  snapshot.refs.read.reverse();
  probe.replaceReferences('read', snapshot.refs.read);
  fixture.productionCheck(snapshot);
  probe.save(snapshot.point, snapshot.state);

  snapshot.refs.read[1] = snapshot.refs.read[0];
  probe.replaceReferences('read', snapshot.refs.read);
  fixture.productionCheck(snapshot);
  probe.save(snapshot.point, snapshot.state);
  assert.throws(() => fixture.productionConfirm(snapshot), 'Entity confirmation is a separate stronger policy; point.check does not prove complete tool coverage');

  snapshot.refs.read = [];
  probe.replaceReferences('read', snapshot.refs.read);
  assert.throws(() => fixture.productionCheck(snapshot));
  assert.throws(() => probe.save(snapshot.point, snapshot.state));
  assert.equal(probe.loading.coldRelations, 6);
  assert.equal(probe.loading.explicitReferenceRewrites, 3);
});

for (const [name, mutate] of [
  ['contract key', (s) => (record(s, 'model-0').identity.contract.key = 'foreign')],
  ['contract version', (s) => record(s, 'model-0').identity.contract.version++],
  ['reference identity', (s) => (record(s, 'model-0').ref.contextId = 'tool-0')],
  ['parent round', (s) => (record(s, 'model-0').parentRound = 2)],
  ['creation order', (s) => (record(s, 'model-0').identity.order = 99)],
]) {
  test(`cold authentication rejects inaccurate ${name} before point policy`, () => {
    const fixture = createToolPolicyFixture();
    const snapshot = fixture.snapshot('final');
    mutate(snapshot);
    // The old policy fixture assumes already-authenticated ChildFacts. Its
    // shape checks are not a substitute for the call/store identity boundary.
    assert.throws(() => createSavedToolPolicy(fixture, snapshot));
  });
}

test('cold reopen rebuilds reception trust once, then unchanged hot saves do not recheck values', (t) => {
  const fixture = createToolPolicyFixture();
  const snapshot = fixture.snapshot('final');
  const probe = createSavedToolPolicy(fixture, snapshot);
  t.after(probe.close);
  probe.save(snapshot.point, snapshot.state);
  const reopened = probe.reopen();
  assert.equal(reopened.call.stats.restoredCheck, 6);
  assert.equal(reopened.call.stats.restoredBodyReads, 6);
  reopened.facts.save(snapshot.point, snapshot.state, { check: fixture.points.get(snapshot.point).check });
  const before = { ...reopened.facts.stats };
  reopened.facts.save(snapshot.point, snapshot.state, { check: fixture.points.get(snapshot.point).check });
  assert.equal(reopened.facts.stats.baselineValidations, 1);
  assert.equal(reopened.facts.stats.referenceValidationItems - before.referenceValidationItems, 0);
  assert.equal(reopened.call.stats.persistenceCheck, 0);
  assert.equal(reopened.call.stats.receptionEncode, 0);
  assert.equal(reopened.facts.stats.wrappersBuilt - before.wrappersBuilt, 6);
});

test('every policy stage survives cold fact-store authentication without changing its point verdict', () => {
  const fixture = createToolPolicyFixture();
  for (const snapshot of fixture.snapshots.values()) {
    const probe = createSavedToolPolicy(fixture, snapshot);
    try {
      probe.save(snapshot.point, snapshot.state);
      const restored = probe.reopen();
      assert.equal(
        outcome(() => restored.facts.check(snapshot.point, snapshot.state, fixture.points.get(snapshot.point).check)),
        outcome(() => fixture.productionCheck(snapshot)),
        snapshot.name,
      );
      const receptions = snapshot.records.filter((item) => ['accepted', 'handled'].includes(item.reception.status)).length;
      assert.equal(restored.call.stats.restoredCheck, receptions, 'Cold loading authenticates persisted reception values');
      assert.equal(restored.call.stats.receptionEncode, 0, 'Reading cold facts does not publish them again');
    } finally {
      probe.close();
    }
  }
});

function boundedPolicy(t, size) {
  const store = new FactStore();
  t.after(() => store.close());
  const definition = Object.freeze({ name: 'bounded-child' });
  const contract = { key: 'bounded.received', version: 1, childPosition: 'node', check: (value) => assert.equal(typeof value.ordinal, 'number'), codec: { encode: (value) => value, decode: (value) => value } };
  const call = new ReceptionEvidenceCall(store, identity('bounded'), { query: 'fixed' }, { contracts: [contract] });
  let latest;
  for (let index = 0; index < size; index++) {
    latest = call.createChild(`child-${index}`, { ordinal: index }, { position: 'node', contract: 'node@1' });
    call.returned(latest, { ordinal: index });
    call.establish(latest, 'accepted', { ordinal: index }, contract);
    call.addReference('history', latest);
  }
  call.reference('active', latest);
  const facts = new SavedFacts(call, { definitions: [{ definition, position: 'node', contract: 'node@1' }], slots: { active: { cardinality: 'one', definition }, history: { cardinality: 'many', definition } } });
  const check = (state, saved) => {
    assert.equal(saved.children.count(definition), state.size);
    assert.equal(saved.selections.size('history'), state.size);
    const active = saved.references.active;
    const current = saved.children.require(definition, active.ref);
    assert.equal(current.input.ordinal, state.size - 1);
    assert.equal(saved.children.accepted(current.ref, contract).ordinal, state.size - 1);
  };
  const state = { size };
  facts.save('bounded', state, { check });
  return { call, facts, check, state, contract };
}

test('a bounded current policy builds one fact regardless of old relation count', (t) => {
  const samples = [];
  for (const size of [8, 128]) {
    const { call, facts, check, state } = boundedPolicy(t, size);
    const before = { ...facts.stats };
    const beforeCall = { ...call.stats };
    const beforeLedger = { ...call.factStats };
    facts.save('bounded', state, { check });
    const delta = difference(facts.stats, before);
    assert.equal(delta.wrappersBuilt, 1);
    assert.equal(delta.bodyReads, 3);
    assert.equal(delta.enumerationItems, 0);
    assert.equal(delta.referenceItems, 1);
    assert.equal(delta.referenceValidationItems, 1, 'One declared active slot is checked, not the history selection');
    assert.equal(call.factStats.encodedFacts - beforeLedger.encodedFacts, 0);
    assert.equal(call.stats.persistenceCheck - beforeCall.persistenceCheck, 0);
    assert.equal(call.stats.receptionEncode - beforeCall.receptionEncode, 0);
    samples.push(delta);
  }
  assert.deepEqual(samples[0], samples[1], 'Same author query has the same measured hot cost');
});

test('explicit all-values and full-reference reads honestly pay for requested history', (t) => {
  const size = 128;
  const { facts, state } = boundedPolicy(t, size);
  const before = { ...facts.stats };
  facts.save('enumerated', state, {
    check(current, saved) {
      assert.equal(saved.children.values().length, current.size);
      assert.equal(saved.references.history.length, current.size);
    },
  });
  const delta = difference(facts.stats, before);
  assert.equal(delta.enumerationItems, size);
  assert.equal(delta.referenceItems, size);
  assert.equal(delta.wrappersBuilt, size, 'One check reuses its selected wrappers, not old query authority');
  assert.equal(delta.bodyReads, 3 * size);
});
