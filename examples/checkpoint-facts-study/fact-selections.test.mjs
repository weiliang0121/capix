import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactCall } from './fact-call.mjs';
import { FactStore, hash, identity, stableCodec } from './fact-store.mjs';

function fixture(t) {
  const store = new FactStore();
  t.after(() => store.close());
  const call = new FactCall(store, identity('parent'), { query: 'original' });
  const first = call.createChild('first', 'one', { position: 'tool', contract: 'tool@1' });
  const second = call.createChild('second', 'two', { position: 'tool', contract: 'tool@1' });
  return { store, call, first, second };
}

function rewriteEvents(store, edit) {
  let chain = hash('fact-head-study@1');
  const rows = store.query('SELECT seq,body FROM events WHERE owner=? ORDER BY seq').all('parent');
  for (const row of rows) {
    const event = JSON.parse(row.body);
    edit(event);
    const body = JSON.stringify(event);
    const next = hash(JSON.stringify([chain, row.seq, body]));
    store.query('UPDATE events SET previous=?,digest=?,body=? WHERE owner=? AND seq=?').run(chain, next, body, 'parent', row.seq);
    chain = next;
  }
  const head = store.readHead('parent');
  head.chain = chain;
  const body = JSON.stringify(head);
  store.query('UPDATE heads SET body=?,digest=? WHERE owner=?').run(body, hash(body), 'parent');
}

test('many references preserve author order, repeated children, and insertion before a specific occurrence', (t) => {
  const { store, call, first, second } = fixture(t);
  const tail = call.addReference('tools', first);
  const head = call.addReference('tools', second, { before: tail });
  const repeated = call.addReference('tools', first, { before: tail });
  assert.deepEqual(call.references('tools'), [second, first, first]);
  assert.deepEqual(
    call.referenceEntries('tools').map((entry) => entry.id),
    [head, repeated, tail],
  );
  assert.equal(call.referenceSize('tools'), 3);
  assert.equal(call.hasReference('tools', first), true);
  call.save('waiting', { selected: head });
  const resumed = FactCall.reopen(store, 'parent');
  assert.deepEqual(resumed.referenceEntries('tools'), call.referenceEntries('tools'));
  assert.equal(resumed.removeReference('tools', repeated), true);
  assert.equal(resumed.removeReference('tools', repeated), false);
  assert.equal(resumed.hasReference('tools', first), true);
  resumed.removeReference('tools', tail);
  assert.equal(resumed.hasReference('tools', first), false);
  assert.deepEqual(resumed.references('tools'), [second]);
  resumed.save('selected', null);
  const again = FactCall.reopen(store, 'parent');
  assert.deepEqual(again.references('tools'), [second]);
  assert.equal(again.relation(first).phase, 'waiting', 'selection removal does not remove a relation');
});

test('many insertion/removal follows head and tail correctly after removing all occurrences', (t) => {
  const { store, call, first, second } = fixture(t);
  const a = call.addReference('tools', first);
  const b = call.addReference('tools', second);
  call.removeReference('tools', a);
  call.removeReference('tools', b);
  call.save('empty', null);
  assert.equal(call.referenceSize('tools'), 0);
  const resumed = FactCall.reopen(store, 'parent');
  const c = resumed.addReference('tools', second);
  resumed.addReference('tools', first, { before: c });
  resumed.save('again', null);
  assert.deepEqual(FactCall.reopen(store, 'parent').references('tools'), [first, second]);
});

test('slot cardinality remains fixed after clearing or removing the last selection, including cold restore', (t) => {
  const { store, call, first } = fixture(t);
  call.reference('one', first);
  call.clearReference('one');
  const entry = call.addReference('many', first);
  call.removeReference('many', entry);
  call.save('empty', null);
  for (const value of [call, FactCall.reopen(store, 'parent')]) {
    assert.equal(value.referenceOf('one'), undefined);
    assert.equal(value.clearReference('one'), false);
    assert.throws(() => value.addReference('one', first), /cardinality/);
    assert.throws(() => value.reference('many', first), /cardinality/);
    assert.throws(() => value.references('one'), /cardinality/);
    assert.throws(() => value.referenceOf('many'), /cardinality/);
  }
});

test('reference mutation and lookup authenticate the exact child identity and insertion anchor', (t) => {
  const { call, first, second } = fixture(t);
  assert.throws(() => call.addReference('many', { ...first, contract: 'changed' }), /Inaccurate/);
  assert.throws(() => call.addReference('many', { ...first, parentId: 'foreign' }), /Inaccurate/);
  assert.throws(() => call.addReference('many', identity('unknown', 'parent')), /Unknown/);
  assert.throws(() => call.addReference('many', first, { before: 'missing' }), /anchor/);
  const anchor = call.addReference('other', second);
  assert.throws(() => call.addReference('many', first, { before: anchor }), /anchor/);
  assert.throws(() => call.hasReference('many', { ...first, order: 10 }), /Inaccurate/);
  assert.equal(call.referenceSize('many'), 0, 'failed edits have no local selection effect');
});

test('many refs include waiting and handled children, and removal never erases fixed deliveries', (t) => {
  const { store, call, first, second } = fixture(t);
  const occurrence = call.addReference('tools', first);
  call.addReference('tools', second);
  call.failed(first, { code: 'BUSINESS' });
  call.receive(first, { kind: 'skipped' });
  call.save('handled', null);
  call.removeReference('tools', occurrence);
  call.save('waiting', null);
  const resumed = FactCall.reopen(store, 'parent');
  assert.equal(resumed.relation(first).phase, 'handled');
  assert.deepEqual(resumed.value(resumed.relation(first).received), { kind: 'skipped' });
  assert.deepEqual(resumed.references('tools'), [second]);
});

for (const [name, mutate] of [
  ['missing occurrence', (store) => store.query('DELETE FROM many_refs WHERE id=?').run(store.query('SELECT id FROM many_refs LIMIT 1').get().id)],
  ['extra occurrence', (store) => store.query("INSERT INTO many_refs SELECT owner,slot,'extra',NULL,NULL,body FROM many_refs LIMIT 1").run()],
  ['broken neighbour', (store) => store.query("UPDATE many_refs SET next='unknown' WHERE id=(SELECT id FROM many_refs LIMIT 1)").run()],
  ['wrong body', (store) => store.query("UPDATE many_refs SET body='{}'").run()],
  ['wrong slot count', (store) => store.query('UPDATE ref_slots SET size=size+1').run()],
  ['wrong slot kind', (store) => store.query("UPDATE ref_slots SET kind='single'").run()],
  ['missing slot', (store) => store.query('DELETE FROM ref_slots').run()],
  ['extra slot', (store) => store.query("INSERT INTO ref_slots VALUES ('parent','extra','many',NULL,NULL,0)").run()],
]) {
  test(`cold restore rejects ${name} in selection indices`, (t) => {
    const { store, call, first, second } = fixture(t);
    call.addReference('tools', first);
    call.addReference('tools', second);
    call.save('waiting', null);
    mutate(store);
    assert.throws(() => FactCall.reopen(store, 'parent'));
  });
}

for (const [name, edit] of [
  [
    'wrong parent',
    (event) => {
      if (event.type === 'ref-add') event.value.parentId = 'foreign';
    },
  ],
  [
    'wrong child contract',
    (event) => {
      if (event.type === 'ref-add') event.value.contract = 'changed';
    },
  ],
  [
    'missing insertion anchor',
    (event) => {
      if (event.type === 'ref-add') event.before = 'missing';
    },
  ],
  [
    'duplicate occurrence',
    (event) => {
      if (event.type === 'ref-add') event.id = 'same';
    },
  ],
]) {
  test(`cold replay authenticates ${name} even after event hashes are recomputed`, (t) => {
    const { store, call, first, second } = fixture(t);
    call.addReference('tools', first);
    call.addReference('tools', second);
    call.save('waiting', null);
    rewriteEvents(store, edit);
    assert.throws(() => FactCall.reopen(store, 'parent'));
  });
}

test('changes are immutable metadata relative to last acknowledged save; failed check does not consume them', (t) => {
  const { call, first } = fixture(t);
  const item = call.addReference('tools', first);
  const before = call.changes();
  assert.equal(before.baseRevision, 0);
  assert.equal(before.mode, 'live');
  assert.equal(before.events.filter((event) => event.type === 'fact').length, 3);
  assert.ok(before.events.filter((event) => event.type === 'fact').every((event) => !('body' in event) && !('value' in event)));
  assert.throws(() => {
    before.events.push({});
  }, TypeError);
  assert.throws(
    () =>
      call.save('waiting', null, {
        check: (_state, facts) => {
          assert.deepEqual(facts.changes(), before);
          throw new Error('rejected check');
        },
      }),
    /rejected check/,
  );
  assert.deepEqual(call.changes(), before);
  call.save('waiting', null);
  assert.deepEqual(call.changes(), { mode: 'live', baseRevision: 1, events: [] });
  call.removeReference('tools', item);
  assert.deepEqual(call.changes().events, [{ type: 'ref-remove', slot: 'tools', id: item }]);
});

test('state-only edits and point switches still run check with no relation delta', (t) => {
  const { call, first } = fixture(t);
  call.returned(first, 'answer');
  call.receive(first, 'accepted');
  call.reference('answer', first);
  call.save('accepted', { answer: 'accepted' });
  assert.throws(() =>
    call.save(
      'other-point',
      { answer: 'changed' },
      {
        check: (state, facts) => {
          assert.equal(facts.changes().events.length, 0);
          const relation = facts.relation(facts.referenceOf('answer'));
          assert.equal(state.answer, facts.value(relation.received));
        },
      },
    ),
  );
  assert.equal(call.changes().baseRevision, 1);
});

test('pre-store encoding failure keeps changes and does not set uncertain commit', (t) => {
  const store = new FactStore();
  t.after(() => store.close());
  const base = stableCodec();
  let broken = true;
  const codec = {
    ...base,
    encode(value) {
      if (broken) throw new Error('encode failure');
      return base.encode(value);
    },
  };
  const call = new FactCall(store, identity('parent'), null, { codec });
  const material = call.capture('fixed');
  const before = call.changes();
  assert.throws(() => call.save('prepared', { material }), /encode failure/);
  assert.deepEqual(call.changes(), before);
  broken = false;
  call.save('prepared', { material });
  assert.equal(call.changes().events.length, 0);
});

for (const cut of ['head', 'committed']) {
  test(`selection edit and delta remain conservative after ${cut} fault`, (t) => {
    const { store, call, first } = fixture(t);
    call.save('empty', null);
    const item = call.addReference('tools', first);
    assert.throws(
      () =>
        call.save('waiting', null, {
          fault: (stage) => {
            if (stage === cut) throw new Error('fault');
          },
        }),
      /fault/,
    );
    assert.equal(call.changes().baseRevision, 1);
    assert.equal(call.changes().events.length, 1, 'unacknowledged delta not consumed');
    assert.throws(() => call.save('retry', null), /uncertain/);
    const resumed = FactCall.reopen(store, 'parent');
    assert.equal(resumed.referenceSize('tools'), cut === 'head' ? 0 : 1);
    if (cut === 'committed') assert.equal(resumed.referenceEntries('tools')[0].id, item);
    assert.equal(resumed.changes().mode, 'restored');
    assert.equal(resumed.changes().events.length, 0, 'cold reconstruction is not presented as a live change batch');
    resumed.save('checked-again', null, { check: (_state, facts) => assert.equal(facts.changes().mode, 'restored') });
    assert.equal(resumed.changes().mode, 'live');
  });
}

test('material capture freezes local continuation content without declaring a successful call delivery', (t) => {
  const store = new FactStore();
  t.after(() => store.close());
  const call = new FactCall(store, identity('leaf'), { path: 'file' });
  const source = { text: 'old file', version: 7 };
  const material = call.capture(source);
  source.text = 'new file';
  call.save('captured', { material });
  assert.equal(store.readHead('leaf').status, 'active');
  assert.equal(store.readHead('leaf').delivery, null);
  const encoded = call.stats.encodedFacts;
  call.save('validated', { material });
  assert.equal(call.stats.encodedFacts, encoded);
  assert.equal(store.stats.oldBodyReads, 0);
  const resumed = FactCall.reopen(store, 'leaf');
  assert.deepEqual(resumed.value(material), { text: 'old file', version: 7 });
  assert.equal(store.factMeta(material).kind, 'material');
  assert.equal(store.factMeta(material).owner, 'leaf');
  store.query('DELETE FROM facts WHERE id=?').run(material);
  assert.throws(() => FactCall.reopen(store, 'leaf'), /Missing fact/);
});

test('relation count and latest selection use creation order, including updates to older children', (t) => {
  const { store, call, first, second } = fixture(t);
  assert.equal(call.relationCount('tool', 'tool@1'), 2);
  assert.equal(call.latestRelation('tool', 'tool@1').identity.contextId, second.contextId);
  call.returned(first, 'done');
  call.receive(first, 'accepted');
  assert.equal(call.latestRelation('tool', 'tool@1').phase, 'waiting');
  assert.equal(call.relationCount('apply', 'apply@1'), 0);
  call.save('selected', null, {
    check: (_state, facts) => {
      assert.deepEqual(facts.input(), { query: 'original' });
      assert.equal(facts.relationCount(), 2);
      assert.equal(facts.relationCount('tool', 'tool@1'), 2);
      assert.equal(facts.latestRelation('tool', 'tool@1').identity.contextId, second.contextId);
    },
  });
  const resumed = FactCall.reopen(store, 'parent');
  assert.equal(resumed.relationCount('tool', 'tool@1'), 2);
  assert.equal(resumed.latestRelation('tool', 'tool@1').identity.contextId, second.contextId);
  assert.equal(resumed.stats.authoredScans, 0);
});

test('many append and exact membership queries do not enumerate or reencode earlier selections', (t) => {
  const store = new FactStore();
  t.after(() => store.close());
  const call = new FactCall(store, identity('parent'), null);
  const children = 128;
  let priorEvents = 0;
  for (let index = 0; index < children; index++) {
    const child = call.createChild(`child-${index}`, index);
    call.addReference('tools', child);
    call.save(
      'waiting',
      { index },
      {
        check: (_state, facts) => {
          assert.equal(facts.referenceSize('tools'), index + 1);
          assert.equal(facts.hasReference('tools', child), true);
        },
      },
    );
    assert.equal(store.stats.metadataEvents - priorEvents, index === 0 ? 4 : 3);
    priorEvents = store.stats.metadataEvents;
  }
  assert.equal(call.stats.encodedFacts, children + 1);
  assert.equal(call.stats.referenceScans, 0);
  assert.equal(call.stats.authoredScans, 0);
  assert.equal(store.stats.oldBodyReads, 0);
  const before = store.stats.metadataEvents;
  call.save('no-change', null);
  assert.equal(store.stats.metadataEvents, before);
  assert.equal(call.references('tools').length, children);
  assert.equal(call.stats.referenceScans, children, 'full enumeration explicitly pays for chosen scope');
});
