import assert from 'node:assert/strict';
import test from 'node:test';
import { FactCall } from './fact-call.mjs';
import { FactStore, identity, stableCodec } from './fact-store.mjs';
import { LocalProgress } from './local-progress.mjs';
import { StableValues } from './stable.mjs';

function setup(t, owner = 'parent') {
  const store = new FactStore();
  t.after(() => store.close());
  const call = new FactCall(store, identity(owner), { input: 'fixed' });
  return { store, call, progress: new LocalProgress(call) };
}

function item(key, revision = 1) {
  return { key, revision, calls: [{ id: `${key}:a` }, { id: `${key}:b` }], content: { text: key } };
}

function state(prefix, current, cursor = 0, active = null) {
  return { prefix, current: current === null ? null : { key: current.key, revision: current.revision }, cursor, active };
}

function reopen(store, owner = 'parent') {
  const values = new StableValues();
  const codec = stableCodec(values);
  const restored = store.restore(owner, new Map([[codec.key, codec]]));
  const call = new FactCall(store, restored.head.identity, undefined, { values, codec, restored });
  const progress = new LocalProgress(call);
  progress.check(restored.head.point, restored.state);
  return { call, progress, restored };
}

test('local material is fixed at capture, while durable head changes only at save', (t) => {
  const { store, call, progress } = setup(t);
  const original = item('one');
  const prefix = progress.append(null, original);
  original.content.text = 'changed';
  original.calls[0].id = 'changed';
  assert.equal(store.readHead('parent'), undefined);
  assert.equal(call.material(prefix.id).item.content.text, 'one');
  progress.save('processing', state(prefix, item('one'), 0, 'one:a'));
  const durable = reopen(store);
  assert.equal(durable.progress.materialize(prefix)[0].content.text, 'one');
  assert.equal(durable.restored.state.active, 'one:a');
  assert.equal(store.stats.factsWritten, 2);
});

test('two selected branches and an old prefix remain independently meaningful', (t) => {
  const { store, progress } = setup(t);
  const first = progress.append(null, item('one'));
  const left = progress.append(first, item('left'));
  const right = progress.append(first, item('right'));
  progress.save('processing', state(left, item('left')));
  progress.save('processing', state(right, item('right')));
  progress.save('processing', state(first, item('one')));
  assert.deepEqual(
    progress.materialize(left).map((entry) => entry.key),
    ['one', 'left'],
  );
  assert.deepEqual(
    progress.materialize(right).map((entry) => entry.key),
    ['one', 'right'],
  );
  assert.deepEqual(
    progress.materialize(first).map((entry) => entry.key),
    ['one'],
  );
  const durable = reopen(store);
  assert.deepEqual(durable.restored.state.prefix, first);
  assert.deepEqual(
    durable.progress.materialize(right).map((entry) => entry.key),
    ['one', 'right'],
  );
});

test('same token does not certify current, cursor, active, or a changed point', (t) => {
  const { store, progress } = setup(t);
  const prefix = progress.append(null, item('one'));
  const valid = state(prefix, item('one'));
  progress.save('processing', valid);
  const before = store.readHead('parent');
  const invalid = [
    ['processing', { ...valid, current: { key: 'different', revision: 1 } }],
    ['processing', { ...valid, current: { key: 'one', revision: 2 } }],
    ['processing', { ...valid, cursor: 3 }],
    ['processing', { ...valid, cursor: 1, active: 'one:a' }],
    ['completed', valid],
  ];
  for (const [point, candidate] of invalid) {
    assert.throws(() => progress.save(point, candidate));
    assert.deepEqual(store.readHead('parent'), before);
  }
  progress.save('processing', state(prefix, item('one'), 1, 'one:b'));
  progress.save('completed', state(prefix, item('one'), 2));
  assert.equal(progress.stats.nodeChecks, 1);
  assert.equal(progress.stats.headChecks, 8);
});

test('old token may be chosen, but cannot impersonate a longer or different selection', (t) => {
  const { progress } = setup(t);
  const first = progress.append(null, item('one'));
  const next = progress.append(first, item('two'));
  progress.save('processing', state(next, item('two')));
  assert.throws(() => progress.save('processing', state({ ...first, count: next.count }, item('one'))), /token.*match/i);
  assert.throws(() => progress.save('processing', state(first, item('two'))), /Current material/);
  progress.save('processing', state(first, item('one')));
});

test('selection requires accurate owner, role, and a present local material node', (t) => {
  const { call, progress } = setup(t);
  const prefix = progress.append(null, item('one'));
  assert.throws(() => progress.check('processing', state({ ...prefix, owner: 'other' }, item('one'))), /owner/);
  assert.throws(() => progress.check('processing', state({ ...prefix, role: 'other' }, item('one'))), /role/);
  assert.throws(() => progress.check('processing', state({ ...prefix, id: 'missing' }, item('one'))), /material|fact/i);
  assert.throws(() => progress.check('processing', state({ ...prefix, id: 'parent:input' }, item('one'))), /material/i);
  const bad = call.capture({ ...call.material(prefix.id), owner: 'other' });
  assert.throws(() => progress.check('processing', state({ ...prefix, id: bad }, item('one'))), /owner/);
});

test('generic material storage does not replace local predecessor validation', (t) => {
  const { call, progress } = setup(t);
  const prefix = progress.append(null, item('one'));
  const malformed = call.capture({ ...call.material(prefix.id), count: 2 });
  assert.throws(() => progress.check('processing', state({ ...prefix, id: malformed, count: 2 }, item('one'))), /position mismatch/);
  const missing = call.capture({ ...call.material(prefix.id), count: 2, previous: { ...prefix, id: 'missing' } });
  assert.throws(() => progress.check('processing', state({ ...prefix, id: missing, count: 2 }, item('one'))), /material|fact/i);
});

test('cold reconstruction refuses a missing committed material node', (t) => {
  const { store, progress } = setup(t);
  const first = progress.append(null, item('one'));
  const second = progress.append(first, item('two'));
  progress.save('processing', state(second, item('two')));
  store.db.prepare('DELETE FROM facts WHERE id=?').run(first.id);
  assert.throws(() => reopen(store), /fact/i);
});

for (const cut of ['facts', 'events', 'before-head', 'head']) {
  test(`commit cut at ${cut} rolls back local node and head together`, (t) => {
    const { store, call, progress } = setup(t);
    const first = progress.append(null, item('one'));
    progress.save('processing', state(first, item('one')));
    const before = store.readHead('parent');
    const fact = call.capture({ result: 'new local fact' });
    const second = progress.append(first, { ...item('two'), fact });
    assert.throws(
      () =>
        progress.save('processing', state(second, item('two')), {
          fault: (at) => {
            if (at === cut) throw new Error('cut');
          },
        }),
      /cut/,
    );
    assert.deepEqual(store.readHead('parent'), before);
    assert.equal(store.db.prepare('SELECT count(*) n FROM facts WHERE id IN (?,?)').get(fact, second.id).n, 0);
    assert.throws(() => progress.save('processing', state(first, item('one'))), /uncertain/);
    const durable = reopen(store);
    assert.deepEqual(durable.restored.state.prefix, first);
    assert.deepEqual(
      durable.progress.materialize(first).map((entry) => entry.key),
      ['one'],
    );
  });
}

test('lost receipt after commit does not pretend the old head is still current', (t) => {
  const { store, progress } = setup(t);
  const first = progress.append(null, item('one'));
  progress.save('processing', state(first, item('one')));
  const second = progress.append(first, item('two'));
  assert.throws(
    () =>
      progress.save('processing', state(second, item('two')), {
        fault: (at) => {
          if (at === 'committed') throw new Error('lost receipt');
        },
      }),
    /lost receipt/,
  );
  assert.throws(() => progress.save('processing', state(first, item('one'))), /uncertain/);
  const durable = reopen(store);
  assert.deepEqual(durable.restored.state.prefix, second);
  assert.equal(durable.restored.head.revision, 2);
});

test('stale writer cannot replace the committed selection', (t) => {
  const { store, progress } = setup(t);
  const first = progress.append(null, item('one'));
  progress.save('processing', state(first, item('one')));
  const stale = reopen(store);
  const current = progress.append(first, item('current'));
  progress.save('processing', state(current, item('current')));
  const branch = stale.progress.append(first, item('stale'));
  assert.throws(() => stale.progress.save('processing', state(branch, item('stale'))), /Revision conflict/);
  assert.deepEqual(reopen(store).restored.state.prefix, current);
});

for (const count of [32, 128]) {
  test(`N=${count}: one new local node per save, bounded head, explicit history reads`, (t) => {
    const { store, call, progress } = setup(t);
    let prefix = null;
    let smallest = Infinity;
    let largest = 0;
    for (let index = 0; index < count; index++) {
      const previousEncodings = new Map(call.encodings);
      const before = call.stats.encodedFacts;
      const current = item(String(index).padStart(4, '0'));
      prefix = progress.append(prefix, current);
      progress.save('processing', state(prefix, current));
      assert.equal(call.stats.encodedFacts - before, index === 0 ? 2 : 1);
      for (const [id, times] of previousEncodings) assert.equal(call.encodings.get(id), times, 'Old fact reencoded');
      const bytes = Buffer.byteLength(JSON.stringify(store.readHead('parent')));
      smallest = Math.min(smallest, bytes);
      largest = Math.max(largest, bytes);
    }
    assert.equal(call.stats.encodedFacts, count + 1);
    assert.equal(store.stats.factsWritten, count + 1);
    assert.equal(store.stats.oldBodyReads, 0);
    assert.equal(call.stats.factReads, count, 'Only new local nodes were read from FactCall');
    assert.equal(progress.stats.nodeChecks, count);
    assert.equal(progress.stats.headChecks, count);
    assert.equal(progress.stats.materializedNodes, 0);
    assert.ok(largest < 1000, `Head grew to ${largest} bytes`);
    assert.ok(largest - smallest < 20, `Head grew by ${largest - smallest} bytes`);
    const before = call.stats.encodedFacts;
    const current = item(String(count - 1).padStart(4, '0'));
    progress.save('processing', state(prefix, current, 1, `${current.key}:b`));
    assert.equal(call.stats.encodedFacts, before);
    assert.equal(progress.stats.headChecks, count + 1);
    assert.equal(progress.materialize(prefix).length, count);
    assert.equal(progress.stats.materializedNodes, count);
    const beforeRestoreReads = store.stats.oldBodyReads;
    const durable = reopen(store);
    assert.equal(store.stats.oldBodyReads - beforeRestoreReads, count + 1);
    assert.equal(durable.progress.stats.nodeChecks, count);
    assert.equal(durable.progress.stats.materializedNodes, 0);
    const hotReads = durable.call.stats.factReads;
    durable.progress.check(durable.restored.head.point, durable.restored.state);
    assert.equal(durable.call.stats.factReads, hotReads);
    assert.equal(durable.progress.materialize(prefix).length, count);
    assert.equal(durable.progress.stats.materializedNodes, count);
    t.diagnostic(JSON.stringify({ count, factEncodes: call.stats.encodedFacts, newNodeReads: call.stats.factReads, oldBodyReadsBeforeRecovery: beforeRestoreReads, smallestHeadBytes: smallest, largestHeadBytes: largest, headChecks: progress.stats.headChecks, materializedNodes: progress.stats.materializedNodes, coldFactReads: store.stats.oldBodyReads - beforeRestoreReads, coldNodeChecks: durable.progress.stats.nodeChecks }));
  });
}

test('empty selection still checks its current progress fields', (t) => {
  const { progress } = setup(t);
  progress.save('processing', state(null, null));
  assert.throws(() => progress.save('processing', { ...state(null, null), cursor: 1 }), /Empty selection/);
  assert.throws(() => progress.save('processing', { ...state(null, null), current: { key: 'one', revision: 1 } }), /Empty selection/);
  assert.throws(() => progress.save('processing', { ...state(null, null), active: 'one:a' }), /Empty selection/);
});
