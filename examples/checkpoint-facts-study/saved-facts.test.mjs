import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactStore, hash, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { SavedFacts } from './saved-facts.mjs';

function contract(overrides = {}) {
  return { key: 'text', version: 1, childPosition: 'child', check: (value) => assert.equal(typeof value.text, 'string'), codec: { encode: (value) => value, decode: (value) => value }, ...overrides };
}

function fixture(t, { slots, extraContracts = [] } = {}) {
  const store = new FactStore();
  t.after(() => store.close());
  const owner = identity('parent');
  const registered = contract();
  const definition = {};
  const other = {};
  const registration = {
    definitions: [
      { definition, position: 'child', contract: 'study@1' },
      { definition: other, position: 'other', contract: 'other@1' },
    ],
    slots: slots?.(definition, other) ?? { history: { cardinality: 'many', definition } },
  };
  const call = new ReceptionEvidenceCall(store, owner, { query: 'initial' }, { contracts: [registered, ...extraContracts] });
  const view = new SavedFacts(call, registration);
  return { store, owner, call, view, registered, definition, other, registration };
}

function child(call, registered, id, { phase = 'accepted', position, contract, key } = {}) {
  const target = call.createChild(id, { id }, { ...(position ? { position } : {}), ...(contract ? { contract } : {}), ...(key ? { key } : {}) });
  if (phase === 'waiting') return target;
  if (phase === 'handled') call.failed(target, { message: `failure ${id}` });
  else call.returned(target, { text: id });
  if (phase === 'accepted' || phase === 'handled') call.establish(target, phase, { text: `received ${id}` }, registered);
  return target;
}

test('empty author check builds no historical wrappers or body reads; baseline refs remain authenticated', (t) => {
  const { call, view, registered } = fixture(t);
  for (let index = 0; index < 16; index++) call.addReference('history', child(call, registered, `c${index}`));
  view.save('ready', null);
  assert.equal(view.stats.baselineItems, 16);
  assert.equal(view.stats.wrappersBuilt, 0);
  assert.equal(view.stats.bodyReads, 0);
  const reception = { ...call.stats };
  const scans = call.factStats.referenceScans;
  view.save('ready', null);
  assert.equal(view.stats.baselineItems, 16);
  assert.equal(view.stats.deltaItems, 0);
  assert.equal(call.factStats.referenceScans, scans);
  assert.deepEqual(call.stats, reception);
  assert.equal(view.stats.authorChecks, 2);
});

test('point lookup builds one complete stable wrapper and reuses it only within that view', (t) => {
  const { call, view, registered, definition } = fixture(t);
  let selected;
  for (let index = 0; index < 16; index++) selected = call.addReference('history', child(call, registered, `c${index}`));
  view.save('ready', null);
  const before = { ...call.stats };
  let escaped;
  let port;
  view.save('selected', null, {
    check(_, facts) {
      const one = facts.selections.entry('history', selected).child;
      assert.equal(facts.children.require(definition, one.ref), one);
      assert.equal(facts.children.get(one.ref), one);
      assert.equal(facts.children.accepted(one.ref, registered).text, 'received c15');
      assert.equal(facts.selections.entry('history', selected).child, one);
      assert.equal(facts.input, facts.initialInput);
      assert.equal(one.input.id, 'c15');
      escaped = one;
      port = facts;
    },
  });
  assert.equal(view.stats.wrappersBuilt, 1);
  assert.equal(view.stats.bodyReads, 4, 'Input, returned, reception and parent input are O(1) stable pointer reads');
  assert.equal(view.stats.enumerationItems, 0);
  assert.deepEqual(call.stats, before, 'Reading already certified reception does not rerun its check or codec');
  assert.throws(() => port.children.values(), /window has ended/);
  assert.throws(() => port.input, /window has ended/);
  assert.throws(() => port.references.history, /window has ended/);
  assert.equal(escaped.returned.output.text, 'c15');
  assert.throws(() => {
    escaped.input.id = 'changed';
  }, TypeError);
});

test('escaped pending snapshot never observes later return or reception transitions', (t) => {
  const { call, view, registered } = fixture(t);
  const target = child(call, registered, 'pending', { phase: 'waiting' });
  const occurrence = call.addReference('history', target);
  let old;
  view.save('waiting', null, {
    check(_, facts) {
      old = facts.selections.entry('history', occurrence).child;
    },
  });
  call.returned(target, { text: 'new return' });
  call.establish(target, 'accepted', { text: 'new reception' }, registered);
  view.save('accepted', null, {
    check(_, facts) {
      const now = facts.selections.entry('history', occurrence).child;
      assert.equal(now.reception.status, 'accepted');
      assert.equal(old.returned, undefined);
      assert.equal(old.reception.status, 'pending');
      assert.throws(() => facts.children.get(old.ref), /foreign saved child reference/);
      assert.throws(() => facts.children.get({ ...now.ref }), /foreign saved child reference/);
    },
  });
  assert.equal(old.reception.status, 'pending');
});

test('same-valued receptions keep exact child, declaration and contract authentication', (t) => {
  const alternate = contract({ key: 'alternate' });
  const { call, view, registered, definition, other } = fixture(t, { extraContracts: [alternate] });
  const first = child(call, registered, 'first');
  const second = child(call, alternate, 'second');
  call.addReference('history', first);
  call.addReference('history', second);
  view.save('ready', null, {
    check(_, facts) {
      const [a, b] = facts.references.history;
      assert.equal(facts.children.require(definition, a.ref), a);
      assert.throws(() => facts.children.require(other, a.ref), /another definition/);
      assert.throws(() => facts.children.accepted(a.ref, alternate), /contract/);
      assert.throws(() => facts.children.accepted(a.ref, { ...registered }), /exact registration/);
      assert.throws(() => facts.children.accepted(b.ref, registered), /contract/);
      assert.throws(() => facts.children.handled(a.ref, registered), /outcome/);
    },
  });
});

test('explicit configured reception alias names the same bound contract without weakening checks', (t) => {
  const { call, registered, definition, registration } = fixture(t);
  const alias = {};
  const view = new SavedFacts(call, { ...registration, receptions: [{ reception: alias, contract: registered }] });
  call.addReference('history', child(call, registered, 'one'));
  view.save('ready', null, {
    check(_, facts) {
      const selected = facts.references.history[0];
      assert.equal(facts.children.require(definition, selected.ref), selected);
      assert.equal(facts.children.accepted(selected.ref, alias).text, 'received one');
      assert.throws(() => facts.children.accepted(selected.ref, {}), /exact registration/);
    },
  });
});

test('handled snapshot preserves original failure and fixed handled value', (t) => {
  const { call, view, registered } = fixture(t);
  call.addReference('history', child(call, registered, 'failed', { phase: 'handled' }));
  view.save('handled', null, {
    check(_, facts) {
      const one = facts.references.history[0];
      assert.deepEqual(one.returned, { status: 'failed', diagnostic: { message: 'failure failed' } });
      assert.equal(facts.children.handled(one.ref, registered).text, 'received failed');
      assert.throws(() => facts.children.accepted(one.ref, registered), /outcome/);
    },
  });
});

test('many refs preserve order and duplicates; occurrence removal does not remove underlying relation', (t) => {
  const { call, view, registered } = fixture(t);
  const a = child(call, registered, 'a');
  const b = child(call, registered, 'b');
  const first = call.addReference('history', a);
  const second = call.addReference('history', b);
  const third = call.addReference('history', a);
  view.save('one', null, {
    check(_, facts) {
      assert.deepEqual(
        facts.references.history.map((item) => item.input.id),
        ['a', 'b', 'a'],
      );
      assert.equal(facts.references.history[0], facts.references.history[2]);
    },
  });
  const scans = call.factStats.referenceScans;
  call.removeReference('history', first);
  const fourth = call.addReference('history', a, { before: second });
  view.save('two', null, {
    check(_, facts) {
      assert.equal(facts.selections.size('history'), 3);
      assert.equal(facts.selections.entry('history', first), undefined);
      assert.equal(facts.selections.entry('history', fourth).child.input.id, 'a');
      assert.equal(facts.selections.entry('history', third).child.input.id, 'a');
      assert.equal(facts.children.count(), 2);
    },
  });
  assert.equal(call.factStats.referenceScans, scans, 'Occurrence point lookup does not enumerate an array');
  assert.equal(view.stats.deltaItems, 1);
});

test('full enumeration is explicit, charged and returns every relation independently of refs', (t) => {
  const { call, view, registered, definition } = fixture(t);
  for (let index = 0; index < 5; index++) child(call, registered, `c${index}`, { key: `key${index}` });
  view.save('all', null, {
    check(_, facts) {
      assert.equal(facts.children.count(definition), 5);
      assert.equal(facts.children.latest(definition).key, 'key4');
      assert.equal(facts.children.values().length, 5);
      assert.equal(facts.children.list(definition).length, 5);
      assert.throws(() => facts.children.requireUnique(definition), /exactly one/);
    },
  });
  assert.equal(view.stats.wrappersBuilt, 5);
  assert.equal(view.stats.enumerationItems, 15);
  assert.equal(view.stats.bodyReads, 15);
});

for (const hot of [false, true]) {
  test(`unread wrong-target many selection is rejected (${hot ? 'hot delta' : 'initial baseline'})`, (t) => {
    const { call, view, registered, store, owner } = fixture(t);
    if (hot) view.save('empty', null);
    const wrong = child(call, registered, 'wrong', { phase: 'waiting', position: 'other', contract: 'other@1' });
    call.addReference('history', wrong);
    assert.throws(() => view.save('invalid', null), /another definition/);
    assert.equal(store.readHead(owner.contextId)?.revision ?? 0, hot ? 1 : 0);
    assert.equal(view.stats.wrappersBuilt, 0);
  });
}

test('unknown refs, wrong cardinality and missing required single reject without author reads', (t) => {
  const a = fixture(t);
  a.call.addReference('unknown', child(a.call, a.registered, 'unknown-child'));
  assert.throws(() => a.view.save('invalid', null), /Unknown reference slot/);
  const b = fixture(t);
  b.call.reference('history', child(b.call, b.registered, 'single-child'));
  assert.throws(() => b.view.save('invalid', null), /cardinality/);
  const c = fixture(t, { slots: (definition) => ({ active: { cardinality: 'one', definition } }) });
  assert.throws(() => c.view.save('invalid', null), /Missing required single/);
});

test('single selection is validated each save, including no new relation and same point', (t) => {
  const { call, view, registered, store, owner } = fixture(t, { slots: (definition) => ({ active: { cardinality: 'one', definition } }) });
  const one = child(call, registered, 'one');
  call.reference('active', one);
  view.save('waiting', { selected: 'one' });
  call.clearReference('active');
  assert.throws(() => view.save('waiting', { selected: 'one' }), /Missing required single/);
  assert.equal(store.readHead(owner.contextId).revision, 1);
});

test('no new fact does not exempt changed state, point or refs from author check', (t) => {
  const { call, view, registered, store, owner } = fixture(t);
  const a = child(call, registered, 'a');
  const b = child(call, registered, 'b');
  const selected = call.addReference('history', a);
  const check = (state, facts, point) => {
    assert.equal(point, 'ready', 'Wrong point');
    assert.equal(state.expected, facts.references.history[0].input.id, 'Wrong state selection');
  };
  view.save('ready', { expected: 'a' }, { check });
  assert.throws(() => view.save('ready', { expected: 'b' }, { check }), /Wrong state selection/);
  assert.throws(() => view.save('other', { expected: 'a' }, { check }), /Wrong point/);
  call.removeReference('history', selected);
  call.addReference('history', b);
  assert.throws(() => view.save('ready', { expected: 'a' }, { check }), /Wrong state selection/);
  assert.equal(store.readHead(owner.contextId).revision, 1);
  assert.equal(view.stats.authorChecks, 4);
});

test('out-of-band save cannot silently consume a new selection authentication delta', (t) => {
  const { call, view, registered } = fixture(t);
  view.save('one', null);
  const wrong = child(call, registered, 'wrong', { phase: 'waiting', position: 'other', contract: 'other@1' });
  call.addReference('history', wrong);
  call.save('bypass', null);
  assert.throws(() => view.save('checked', null), /another definition/);
  assert.equal(view.stats.baselineValidations, 2);
});

for (const action of ['async', 'then-getter', 'mutate', 'reentrant']) {
  test(`check ${action} rejects, closes query ports and does not save`, (t) => {
    const { call, view, store, owner } = fixture(t);
    let port;
    assert.throws(
      () =>
        view.save('invalid', null, {
          check(_, facts) {
            port = facts;
            if (action === 'async') return Promise.resolve();
            if (action === 'then-getter')
              return Object.defineProperty({}, 'then', {
                get() {
                  throw new Error('then getter');
                },
              });
            if (action === 'mutate') return call.createChild('during-check', null);
            return view.save('reentrant', null);
          },
        }),
      /synchronous|then getter|Reentrant/,
    );
    assert.throws(() => port.children.values(), /window has ended/);
    assert.equal(store.readHead(owner.contextId), undefined);
  });
}

test('check-only facade holds the same mutation lock and does not publish a head', (t) => {
  const { call, view, store, owner } = fixture(t);
  view.check('read-only', { expected: 'initial' }, (state, facts) => {
    assert.equal(facts.input.query, state.expected);
    assert.throws(() => call.capture({ changed: true }), /Reentrant/);
  });
  assert.equal(store.readHead(owner.contextId), undefined);
});

test('cold reopen has new proof, full reception checks and independently authenticated selected refs', (t) => {
  const { call, view, registered, registration, store, owner } = fixture(t);
  call.addReference('history', child(call, registered, 'one'));
  view.save('ready', { expected: 'received one' });
  const replacement = contract();
  const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts: [replacement] });
  assert.equal(restored.stats.restoredCheck, 1);
  const cold = new SavedFacts(restored, registration);
  cold.check('ready', { expected: 'received one' }, (state, facts) => {
    const one = facts.references.history[0];
    assert.equal(facts.children.accepted(one.ref, replacement).text, state.expected);
    assert.throws(() => facts.children.accepted(one.ref, registered), /exact registration/);
  });
  assert.equal(cold.stats.baselineItems, 1);
  assert.equal(store.readHead(owner.contextId).revision, 1, 'Author check does not advance durable state');
});

test('failed author check cannot certify baseline for subsequent saves', (t) => {
  const { call, view, registered } = fixture(t);
  call.addReference('history', child(call, registered, 'one'));
  assert.throws(
    () =>
      view.save('invalid', null, {
        check() {
          throw new Error('author rejected');
        },
      }),
    /author rejected/,
  );
  view.save('valid', null);
  assert.equal(view.stats.baselineItems, 2);
});

for (const wrong of [
  { position: 'absent', contract: 'study@1' },
  { position: 'child', contract: 'changed@1' },
]) {
  for (const stage of ['initial', 'hot', 'cold']) {
    test(`unselected and unread ${JSON.stringify(wrong)} declaration rejects at ${stage} boundary`, (t) => {
      const { call, view, store, owner, registration } = fixture(t);
      if (stage === 'hot') view.save('empty', null);
      call.createChild('unselected', null, wrong);
      if (stage === 'cold') {
        // The generic ledger knows relation identity, but has no author binding
        // catalog. Rebinding must authenticate it before any author check.
        call.save('generic-ledger', null);
        const reopened = ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract()] });
        const cold = new SavedFacts(reopened, registration);
        assert.throws(() => cold.check('generic-ledger', null), /Unregistered child definition\/contract/);
        assert.equal(cold.stats.bodyReads, 0);
        assert.equal(cold.stats.wrappersBuilt, 0);
        assert.equal(cold.stats.authorChecks, 0);
      } else {
        assert.throws(() => view.save('invalid', null), /Unregistered child definition\/contract/);
        assert.equal(store.readHead(owner.contextId)?.revision ?? 0, stage === 'hot' ? 1 : 0);
        assert.equal(view.stats.bodyReads, 0);
        assert.equal(view.stats.wrappersBuilt, 0);
        assert.equal(stage === 'hot' ? view.stats.relationDeltaItems : view.stats.relationBaselineItems, 1);
      }
    });
  }
}

test('valid unselected relations authenticate once at baseline then only at introduction', (t) => {
  const { call, view, registered } = fixture(t);
  const old = call.createChild('old', null);
  view.save('first', null);
  assert.equal(view.stats.relationBaselineItems, 1);
  assert.equal(call.factStats.relationMetadataVisits, 1);
  call.returned(old, { text: 'old' });
  call.establish(old, 'accepted', { text: 'old' }, registered);
  call.createChild('new', null);
  view.save('second', null);
  view.save('unchanged', null);
  assert.equal(view.stats.relationBaselineItems, 1);
  assert.equal(view.stats.relationDeltaItems, 1);
  assert.equal(call.factStats.relationMetadataVisits, 1);
  assert.equal(view.stats.bodyReads, 0);
  assert.equal(view.stats.wrappersBuilt, 0);
  assert.equal(view.stats.enumerationItems, 0);
});

test('out-of-band save cannot erase authentication obligation for an unselected relation', (t) => {
  const { call, view } = fixture(t);
  view.save('empty', null);
  call.createChild('absent', null, { position: 'absent', contract: 'absent@1' });
  call.save('bypass', null);
  assert.throws(() => view.check('bypass', null), /Unregistered child definition\/contract/);
  assert.equal(view.stats.relationBaselineItems, 1);
  assert.equal(view.stats.bodyReads, 0);
});

test('reading an absent declared many slot never registers mutable or persistent selection state', (t) => {
  const { call, view } = fixture(t);
  const changes = call.changes();
  view.check('empty', null, (_, facts) => {
    assert.equal(facts.selections.size('history'), 0);
    assert.equal(facts.selections.entry('history', 'absent'), undefined);
    assert.deepEqual(facts.references.history, []);
    assert.deepEqual(facts.selections.entries('history'), []);
  });
  assert.deepEqual(call.referenceSlots(), []);
  assert.deepEqual(call.changes(), changes);
});

test('projection rejects inherited source names while exact own reserved names remain legal', (t) => {
  const regular = fixture(t);
  for (const source of ['__proto__', 'constructor', 'toString']) assert.throws(() => regular.view.saveProjection('invalid', null, { alias: source }), /Unknown reference slot/);
  const { call, registered, definition } = fixture(t);
  const sources = Object.fromEntries([['__proto__', { cardinality: 'many', definition }]]);
  const view = new SavedFacts(call, { definitions: [{ definition, position: 'child', contract: 'study@1' }], slots: sources });
  call.addReference('__proto__', child(call, registered, 'one'));
  const layout = Object.fromEntries([['__proto__', '__proto__']]);
  view.saveProjection('reserved', null, layout, {
    check(_, facts) {
      assert.deepEqual(Object.keys(facts.references), ['__proto__']);
      assert.equal(facts.references.__proto__[0].input.id, 'one');
    },
  });
});

test('projection capture cannot reenter its source while resolving author aliases', (t) => {
  const { call, view, store, owner } = fixture(t);
  const projection = new Proxy(
    {},
    {
      ownKeys() {
        call.save('injected', null);
        return [];
      },
    },
  );
  assert.throws(() => view.saveProjection('invalid', null, projection), /Reentrant/);
  assert.throws(() => view.checkProjection('invalid', null, projection), /Reentrant/);
  assert.equal(store.readHead(owner.contextId), undefined);
});

test('receipt loss does not publish a trusted hot baseline or permit further save', (t) => {
  const { call, view, registered, store, owner, registration } = fixture(t);
  call.addReference('history', child(call, registered, 'one'));
  let escaped;
  assert.throws(
    () =>
      view.save('ready', null, {
        check(_, facts) {
          escaped = facts;
        },
        fault(stage) {
          if (stage === 'committed') throw new Error('lost receipt');
        },
      }),
    /lost receipt/,
  );
  assert.equal(store.readHead(owner.contextId).revision, 1);
  assert.throws(() => view.save('retry', null), /uncertain/);
  assert.throws(() => view.check('retry', null), /uncertain/);
  assert.throws(() => escaped.children.values(), /window has ended/);
  const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract()] });
  const cold = new SavedFacts(restored, registration);
  cold.check('ready', null);
  assert.equal(cold.stats.baselineItems, 1);
  assert.equal(restored.stats.restoredCheck, 1);
});

for (const mode of ['invalid shape', 'changed later']) {
  test(`cold relation key ${mode} rejects even after event-chain hashes are recomputed`, (t) => {
    const { call, view, registered, store, owner } = fixture(t);
    child(call, registered, 'one', { key: 'original' });
    view.save('ready', null);
    const events = store.query('SELECT seq,body FROM events WHERE owner=? ORDER BY seq').all(owner.contextId);
    let chain = hash('fact-head-study@1');
    for (const row of events) {
      const event = JSON.parse(row.body);
      if (event.type === 'relation') {
        if (mode === 'invalid shape') event.value.key = 7;
        else if (event.value.phase === 'returned') event.value.key = 'changed';
      }
      const body = JSON.stringify(event);
      const next = hash(JSON.stringify([chain, row.seq, body]));
      store.query('UPDATE events SET previous=?,digest=?,body=? WHERE owner=? AND seq=?').run(chain, next, body, owner.contextId, row.seq);
      chain = next;
    }
    const head = store.readHead(owner.contextId);
    head.chain = chain;
    const body = JSON.stringify(head);
    store.query('UPDATE heads SET body=?,digest=? WHERE owner=?').run(body, hash(body), owner.contextId);
    assert.throws(() => ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract()] }), /relation key|Relation key changed/);
  });
}
