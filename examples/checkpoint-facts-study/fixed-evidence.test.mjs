import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactCall } from './fact-call.mjs';
import { FactStore, hash, identity } from './fact-store.mjs';
import { FixedModelEvidence } from './fixed-evidence.mjs';

function fixture(t) {
  const store = new FactStore();
  t.after(() => store.close());
  const root = new FactCall(store, identity('parent'), { query: 'fixed' });
  const policyFact = root.capture({ statement: 'selected-model-input@1', version: 'policy@1', key: 'decision' });
  const states = [0, 1].map((position) => {
    const prefixFact = root.capture({ owner: 'parent', count: position, previous: null });
    const child = root.createChild(`model-${position}`, { prefixFact, position, policyVersion: 'policy@1', key: 'decision' }, { position: 'model', contract: 'model@1' });
    root.returned(child, { calls: [{ id: `tool-${position}` }] });
    root.receive(child, { accepted: child.contextId });
    const occurrence = root.addReference('models', child);
    return { owner: 'parent', statement: 'selected-model-input@1', policyFact, policyVersion: 'policy@1', child, inputFact: root.relation(child).input, prefixFact, slot: 'models', occurrence, position, current: child.contextId, cursor: 0 };
  });
  return { store, root, states, probe: new FixedModelEvidence(root) };
}

test('exact fixed tuple reuses A with zero old body reads and encodings, while B still runs', (t) => {
  const { root, states, probe } = fixture(t);
  probe.save('processing', states[0]);
  const first = { ...probe.stats };
  const encodings = new Map(root.encodings);
  const reads = root.stats.factReads;
  probe.save('waiting-tool', states[0]);
  assert.equal(probe.stats.bodyReads - first.bodyReads, 0);
  assert.equal(root.stats.factReads - reads, 0);
  assert.deepEqual(root.encodings, encodings);
  assert.equal(probe.stats.historicalChecks, 1);
  assert.equal(probe.stats.reused, 1);
  assert.equal(probe.stats.currentChecks, 2);
  assert.equal(probe.stats.installed, 1);
  assert.equal(probe.stats.selectionScans, 4, 'Selection enumeration remains an explicit cost');
});

test('same business key on another child is a new assertion, not reusable evidence', (t) => {
  const { states, probe } = fixture(t);
  probe.save('processing', states[0]);
  const reads = probe.stats.bodyReads;
  probe.save('processing', states[1]);
  assert.equal(probe.stats.bodyReads - reads, 4);
  assert.equal(probe.stats.historicalChecks, 2);
  assert.equal(probe.stats.installed, 2);
  const after = probe.stats.bodyReads;
  probe.save('completed', { ...states[1], cursor: 1 });
  assert.equal(probe.stats.bodyReads, after);
});

test('reordering stable refs requires a new position assertion and rejects the old input', (t) => {
  const { root, states, probe } = fixture(t);
  probe.save('processing', states[0]);
  root.removeReference('models', states[0].occurrence);
  const occurrence = root.addReference('models', states[0].child);
  const before = probe.stats.historicalChecks;
  assert.throws(() => probe.save('processing', { ...states[0], occurrence, position: 1 }), /another selected position/);
  assert.equal(probe.stats.historicalChecks, before + 1);
  assert.equal(probe.stats.installed, 1);
});

test('same child and position under a new occurrence rechecks A without forbidding that choice', (t) => {
  const { root, states, probe } = fixture(t);
  probe.save('processing', states[0]);
  root.removeReference('models', states[0].occurrence);
  const occurrence = root.addReference('models', states[0].child, { before: states[1].occurrence });
  probe.save('processing', { ...states[0], occurrence });
  assert.equal(probe.stats.historicalChecks, 2);
  assert.equal(probe.stats.installed, 2);
});

test('equal prefix content and a matching claimed digest do not prove exact selected identity', (t) => {
  const { root, states, probe } = fixture(t);
  probe.save('processing', states[0]);
  const content = root.material(states[0].prefixFact);
  const prefixFact = root.capture(content);
  const before = probe.stats.historicalChecks;
  assert.throws(() => probe.save('processing', { ...states[0], prefixFact, evidenceDigest: hash(JSON.stringify(content)) }), /another prefix/);
  assert.equal(probe.stats.historicalChecks, before + 1);
  assert.equal(probe.stats.installed, 1);
});

test('changed statement policy is checked against the original fixed input', (t) => {
  const { root, states, probe } = fixture(t);
  probe.save('processing', states[0]);
  const policyFact = root.capture({ statement: states[0].statement, version: 'policy@2', key: 'decision' });
  assert.throws(() => probe.save('processing', { ...states[0], policyFact, policyVersion: 'policy@2' }), /another policy/);
  assert.equal(probe.stats.historicalChecks, 2);
  assert.equal(probe.stats.installed, 1);
});

for (const [label, patch, pattern] of [
  ['owner', { owner: 'another-owner' }, /Wrong selection owner/],
  ['statement', { statement: 'different-statement@1' }, /Unknown business statement/],
  ['input identity', { inputFact: 'forged-input' }, /Inaccurate input fact/],
  ['child', { child: identity('forged', 'parent', 'model', 1, 'model@1') }, /Different selected child/],
  ['occurrence', { occurrence: 'forged-occurrence' }, /Different selected occurrence/],
  ['slot', { slot: 'other' }, /Wrong selection slot/],
  ['current model', { current: 'another-model' }, /Wrong current model/],
]) {
  test(`certified evidence does not authorize a changed ${label}`, (t) => {
    const { states, probe } = fixture(t);
    probe.save('processing', states[0]);
    assert.throws(() => probe.save('processing', { ...states[0], ...patch }), pattern);
    assert.equal(probe.stats.installed, 1);
  });
}

test('foreign or wrong-kind local material cannot be read by presenting a fact identity', (t) => {
  const { store, root, states, probe } = fixture(t);
  const foreign = new FactCall(store, identity('foreign'), null);
  const foreignPrefix = foreign.capture({ owner: 'parent', count: 0 });
  foreign.save('ready', null);
  assert.throws(() => probe.save('processing', { ...states[0], prefixFact: foreignPrefix }), /Missing local material/);
  assert.throws(() => probe.save('processing', { ...states[0], prefixFact: root.relation(states[0].child).input }), /Foreign material owner/);
  assert.throws(() => probe.save('processing', { ...states[0], prefixFact: 'parent:input' }), /not local material/);
  assert.equal(probe.stats.installed, 0);
});

for (const [point, patch, pattern] of [
  ['processing', { cursor: 2 }, /Cursor exceeds/],
  ['completed', { cursor: 0 }, /not completed/],
  ['waiting-tool', { cursor: 1 }, /No current tool/],
  ['unknown', { cursor: 0 }, /Unknown current point/],
]) {
  test(`B checks ${point}/${patch.cursor} even without new facts`, (t) => {
    const { root, states, probe } = fixture(t);
    probe.save('processing', states[0]);
    const before = { ...probe.stats };
    const reads = root.stats.factReads;
    assert.throws(() => probe.save(point, { ...states[0], ...patch }), pattern);
    assert.equal(probe.stats.bodyReads - before.bodyReads, 0);
    assert.equal(root.stats.factReads, reads);
    assert.equal(probe.stats.currentChecks, before.currentChecks + 1);
  });
}

test('successful preparation without save confirmation installs no evidence', (t) => {
  const { states, probe } = fixture(t);
  probe.check('processing', states[0]);
  probe.check('processing', states[0]);
  assert.equal(probe.stats.bodyReads, 8);
  assert.equal(probe.stats.installed, 0);
  probe.save('processing', states[0]);
  assert.equal(probe.stats.bodyReads, 12);
  assert.equal(probe.stats.installed, 1);
});

test('failed B after successful A does not install partial evidence', (t) => {
  const { states, probe } = fixture(t);
  assert.throws(() => probe.save('completed', states[0]), /not completed/);
  assert.equal(probe.stats.installed, 0);
  probe.save('processing', states[0]);
  assert.equal(probe.stats.historicalChecks, 2);
  assert.equal(probe.stats.bodyReads, 8);
});

for (const cut of ['before-head', 'committed']) {
  test(`unconfirmed save at ${cut} installs no evidence and requires cold reopening`, (t) => {
    const { store, root, states, probe } = fixture(t);
    root.save('seed', states[0]);
    assert.throws(
      () =>
        probe.save('processing', states[0], {
          fault: (at) => {
            if (at === cut) throw new Error('lost');
          },
        }),
      /lost/,
    );
    assert.equal(probe.stats.installed, 0);
    assert.throws(() => probe.save('processing', states[0]), /uncertain/);
    assert.equal(store.readHead('parent').revision, cut === 'committed' ? 2 : 1);
    const reopened = FactCall.reopen(store, 'parent');
    const cold = new FixedModelEvidence(reopened);
    cold.save('processing', states[0]);
    assert.equal(cold.stats.bodyReads, 4);
    assert.equal(cold.stats.historicalChecks, 1);
    assert.equal(cold.stats.installed, 1);
  });
}

test('a forged post-commit receipt cannot install an evidence certificate', (t) => {
  const { store, states, probe } = fixture(t);
  const commit = store.commit.bind(store);
  store.commit = (...args) => ({ ...commit(...args), headDigest: 'forged' });
  assert.throws(() => probe.save('processing', states[0]), /Invalid receipt head/);
  assert.equal(probe.stats.installed, 0);
  assert.equal(store.readHead('parent').revision, 1, 'Committed fact is not treated as rolled back');
});

test('new checker and reopened invocation never inherit process-local assertion evidence', (t) => {
  const { store, root, states, probe } = fixture(t);
  probe.save('processing', states[0]);
  const fresh = new FixedModelEvidence(root);
  fresh.check('processing', states[0]);
  assert.equal(fresh.stats.bodyReads, 4);
  const reopened = FactCall.reopen(store, 'parent');
  const cold = new FixedModelEvidence(reopened);
  cold.save('processing', states[0]);
  assert.equal(cold.stats.bodyReads, 4);
  assert.equal(cold.stats.historicalChecks, 1);
  assert.equal(cold.stats.reused, 0);
  assert.ok(store.stats.restoreEvents > 0, 'Cold reconstruction also performs existing full validation');
});
