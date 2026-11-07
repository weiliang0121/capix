import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { PointFacts } from './point-facts.mjs';
import { StableValues } from './stable.mjs';

function setup(t, customize = () => {}) {
  const store = new FactStore();
  t.after(() => store.close());
  const owner = identity('parent');
  const first = {};
  const second = {};
  const waiting = {
    name: 'waiting',
    version: 1,
    slots: { follow: 'first.one' },
    check(state, facts) {
      assert.equal(facts.references.follow.input.id, state.current);
    },
  };
  const accepted = {
    name: 'accepted',
    version: 1,
    slots: { follow: 'first.many' },
    check(state, facts) {
      assert.deepEqual(
        facts.references.follow.map((item) => item.input.id),
        state.ids,
      );
    },
  };
  const other = {
    name: 'other',
    version: 1,
    slots: { follow: 'second.one' },
    check(state, facts) {
      assert.equal(facts.references.follow.input.id, state.current);
    },
  };
  const idle = {
    name: 'idle',
    version: 1,
    slots: {},
    check(state, facts) {
      assert.deepEqual(Object.keys(facts.references), []);
      assert.equal(state.idle, true);
    },
  };
  const points = [waiting, accepted, other, idle];
  const config = {
    definitions: [
      { definition: first, position: 'first', contract: 'first@1' },
      { definition: second, position: 'second', contract: 'second@1' },
    ],
    sources: { 'first.one': { cardinality: 'one', definition: first }, 'first.many': { cardinality: 'many', definition: first }, 'second.one': { cardinality: 'one', definition: second } },
    points,
  };
  customize({ config, points, waiting, accepted, other, idle, first, second });
  const call = new ReceptionEvidenceCall(store, owner, { input: 'fixed' });
  const view = new PointFacts(call, config);
  const child = (id, position = 'first') => call.createChild(id, { id }, { position, contract: `${position}@1` });
  const reopen = (overrides = {}) => {
    const fresh = ReceptionEvidenceCall.reopen(store, owner);
    return { call: fresh, view: new PointFacts(fresh, { ...config, ...overrides }) };
  };
  return { store, owner, call, view, child, reopen, config, waiting, accepted, other, idle };
}

test('same alias projects one, many, empty and a different target without changing source cardinality', (t) => {
  const { call, view, child, waiting, accepted, other, idle, store, owner } = setup(t);
  const a = child('a');
  call.reference('first.one', a);
  view.save(waiting, { current: 'a' });
  call.addReference('first.many', a);
  call.addReference('first.many', a);
  view.save(accepted, { ids: ['a', 'a'] });
  view.save(idle, { idle: true });
  const b = child('b', 'second');
  call.reference('second.one', b);
  view.save(other, { current: 'b' });
  view.save(waiting, { current: 'a' });
  assert.equal(store.readHead(owner.contextId).revision, 5);
  assert.equal(view.stats.relationBaselineItems, 1);
  assert.equal(view.stats.relationDeltaItems, 1);
  assert.equal(view.stats.baselineItems, 0);
  assert.equal(view.stats.deltaItems, 2);
  assert.equal(call.referenceSize('first.many'), 2);
  assert.equal(call.relationCount(), 2);
});

test('inactive missing singles are allowed but selected single must exist', (t) => {
  const { view, idle, waiting } = setup(t);
  view.save(idle, { idle: true });
  assert.throws(() => view.save(waiting, { current: 'absent' }), /Missing required single/);
});

test('point projection exposes aliases only; hidden sources cannot be queried through selections', (t) => {
  const { call, view, child, waiting } = setup(t, ({ waiting }) => {
    waiting.check = (_, facts) => {
      assert.deepEqual(Object.keys(facts.references), ['follow']);
      assert.equal(facts.references['first.one'], undefined);
      assert.equal(facts.references['first.many'], undefined);
      assert.throws(() => facts.selections.size('first.many'), /Unknown point reference alias/);
      assert.equal(facts.references.follow.input.id, 'a');
    };
  });
  const a = child('a');
  call.reference('first.one', a);
  call.addReference('first.many', a);
  view.save(waiting, null);
});

test('inactive source targets and cardinality still authenticate before empty point check', (t) => {
  const { call, view, child, idle } = setup(t);
  call.reference('first.one', child('wrong', 'second'));
  assert.throws(() => view.save(idle, { idle: true }), /another definition/);
  const separate = setup(t);
  separate.call.reference('first.many', separate.child('wrong-cardinality'));
  assert.throws(() => separate.view.save(separate.idle, { idle: true }), /cardinality/);
});

test('unselected unknown relations and undeclared sources reject despite empty point', (t) => {
  const unknown = setup(t);
  unknown.call.createChild('unknown', null, { position: 'absent', contract: 'absent@1' });
  assert.throws(() => unknown.view.save(unknown.idle, { idle: true }), /Unregistered child/);
  const source = setup(t);
  source.call.reference('absent', source.child('known'));
  assert.throws(() => source.view.save(source.idle, { idle: true }), /Unknown reference slot/);
});

test('changed state or active choice at same point always runs registered check', (t) => {
  const { call, view, child, waiting, store, owner } = setup(t);
  const a = child('a');
  const b = child('b');
  call.reference('first.one', a);
  view.save(waiting, { current: 'a' });
  assert.throws(() => view.save(waiting, { current: 'wrong' }), /strictly equal/);
  call.reference('first.one', b);
  assert.throws(() => view.save(waiting, { current: 'a' }), /strictly equal/);
  view.save(waiting, { current: 'b' });
  assert.equal(store.readHead(owner.contextId).revision, 2);
});

test('old query ports and refs expire after projection switch while returned snapshots stay stable', (t) => {
  let oldFacts;
  let oldChild;
  const { call, view, child, waiting, accepted } = setup(t, ({ waiting, accepted }) => {
    waiting.check = (_, facts) => {
      oldFacts = facts;
      oldChild = facts.references.follow;
    };
    accepted.check = (_, facts) => {
      assert.throws(() => oldFacts.children.values(), /window has ended/);
      assert.throws(() => facts.children.get(oldChild.ref), /foreign saved child reference/);
      assert.equal(oldChild.input.id, 'a');
      assert.equal(facts.references.follow.length, 1);
    };
  });
  const a = child('a');
  call.reference('first.one', a);
  view.save(waiting, null);
  call.addReference('first.many', a);
  view.save(accepted, null);
});

test('exact point registration is required and public object mutation does not replace installed layout or check', (t) => {
  const { call, view, child, waiting } = setup(t);
  call.reference('first.one', child('a'));
  assert.throws(() => view.save({ ...waiting }, { current: 'a' }), /exact registration/);
  waiting.name = 'replaced';
  waiting.version = 99;
  waiting.slots = {};
  waiting.check = () => {};
  assert.throws(() => view.save(waiting, { current: 'wrong' }), /strictly equal/);
  view.save(waiting, { current: 'a' });
});

test('point check is optional but mechanism authentication still applies', (t) => {
  const { call, view, child, waiting } = setup(t, ({ waiting }) => {
    delete waiting.check;
  });
  assert.throws(() => view.save(waiting, null), /Missing required single/);
  call.reference('first.one', child('a'));
  view.save(waiting, null);
});

test('same point name at different versions is rejected during registration', (t) => {
  assert.throws(
    () =>
      setup(t, ({ config, waiting }) => {
        config.points = [waiting, { ...waiting, version: 2 }];
      }),
    /Duplicate point name/,
  );
});

test('unknown source alias is rejected while binding a point', (t) => {
  assert.throws(
    () =>
      setup(t, ({ waiting }) => {
        waiting.slots.follow = 'absent';
      }),
    /Unknown point selection source/,
  );
});

test('cold continuation is closed until original exact head and original point check pass', (t) => {
  const { call, view, child, waiting, idle, store, owner, reopen } = setup(t);
  call.reference('first.one', child('a'));
  view.save(waiting, { current: 'a' });
  const cold = reopen();
  assert.throws(() => cold.view.save(idle, { idle: true }), /must be verified/);
  assert.throws(() => cold.view.check(idle, { idle: true }), /must be verified/);
  assert.throws(() => cold.view.replaceSelection('first.many', []), /must be verified/);
  const result = cold.view.verifySaved(store.readHead(owner.contextId));
  assert.equal(result.point, waiting);
  assert.deepEqual(result.state, { current: 'a' });
  cold.view.save(waiting, { current: 'a' });
});

test('matching owner and revision do not authenticate a forged head or forged state', (t) => {
  const { call, view, child, waiting, store, owner, reopen } = setup(t);
  call.reference('first.one', child('a'));
  view.save(waiting, { current: 'a' });
  const cold = reopen();
  const head = store.readHead(owner.contextId);
  assert.throws(() => cold.view.verifySaved({ ...head, point: 'other' }), /source-authenticated/);
  assert.throws(() => cold.view.verifySaved({ ...head, state: 'invented' }), /source-authenticated/);
  assert.throws(() => cold.view.save(waiting, { current: 'a' }), /must be verified/);
});

for (const kind of ['save', 'mutate', 'async', 'then getter']) {
  test(`cold state decoder ${kind} cannot replace the head being verified or create a continuation`, (t) => {
    const { call, view, child, waiting, store, owner, config } = setup(t);
    call.reference('first.one', child('a'));
    view.save(waiting, { current: 'a' });
    const fresh = ReceptionEvidenceCall.reopen(store, owner);
    const decoder = (head) => {
      if (kind === 'save') fresh.save('unverified', { bad: true });
      if (kind === 'mutate') fresh.clearReference('first.one');
      if (kind === 'async') return Promise.resolve(null);
      if (kind === 'then getter')
        return Object.defineProperty({}, 'then', {
          get() {
            throw new Error('then getter');
          },
        });
      return new StableValues().decode(head.state).value;
    };
    const cold = new PointFacts(fresh, { ...config, decodeState: decoder });
    assert.throws(() => cold.verifySaved(store.readHead(owner.contextId)), /Reentrant|synchronous|then getter/);
    assert.equal(store.readHead(owner.contextId).revision, 1);
    assert.throws(() => cold.save(waiting, { current: 'a' }), /must be verified/);
  });
}

for (const change of ['version', 'alias', 'source', 'target']) {
  test(`cold original point ${change} mismatch refuses compatibility`, (t) => {
    const { call, view, child, waiting, store, owner, config } = setup(t);
    call.reference('first.one', child('a'));
    view.save(waiting, { current: 'a' });
    const renamed = { ...waiting, slots: { ...waiting.slots } };
    const sources = { ...config.sources };
    if (change === 'version') renamed.version++;
    if (change === 'alias') renamed.slots = { child: 'first.one' };
    if (change === 'source') renamed.slots = { follow: 'first.many' };
    if (change === 'target') sources['first.one'] = config.sources['second.one'];
    const cold = ReceptionEvidenceCall.reopen(store, owner);
    const replacement = new PointFacts(cold, { ...config, sources, points: [renamed, ...config.points.filter((item) => item !== waiting)] });
    assert.throws(() => replacement.verifySaved(store.readHead(owner.contextId)), /Unknown saved point|layout changed|another definition/);
    assert.throws(() => replacement.save(renamed, { current: 'a' }), /must be verified/);
  });
}

test('cold inactive choices do not revive through layout switch or one append; explicit complete replacement permits them', (t) => {
  const { call, view, child, waiting, accepted, store, owner, reopen } = setup(t);
  const a = child('a');
  const b = child('b');
  call.reference('first.one', a);
  call.addReference('first.many', b);
  view.save(waiting, { current: 'a' });
  const cold = reopen();
  cold.view.verifySaved(store.readHead(owner.contextId));
  assert.throws(() => cold.view.save(accepted, { ids: ['b'] }), /Inactive selection/);
  cold.call.addReference('first.many', a);
  assert.throws(() => cold.view.save(accepted, { ids: ['b', 'a'] }), /Inactive selection/);
  cold.view.replaceSelection('first.many', [a, a]);
  cold.view.save(accepted, { ids: ['a', 'a'] });
  assert.equal(cold.call.relationCount(), 2);
  assert.equal(cold.call.referenceSize('first.many'), 2);
});

test('empty saved point restores no author selections while retaining relationship facts', (t) => {
  const { call, view, child, waiting, idle, store, owner, reopen } = setup(t);
  const a = child('a');
  call.reference('first.one', a);
  view.save(idle, { idle: true });
  const cold = reopen();
  cold.view.verifySaved(store.readHead(owner.contextId));
  assert.throws(() => cold.view.check(waiting, { current: 'a' }), /Inactive selection/);
  assert.equal(cold.call.relationCount(), 1);
  cold.view.replaceSelection('first.one', a);
  cold.view.save(waiting, { current: 'a' });
});

test('failed replacement checks entire new selection before modifying or covering inactive source', (t) => {
  const { call, view, child, waiting, accepted, store, owner, reopen } = setup(t);
  const a = child('a');
  const wrong = child('wrong', 'second');
  call.reference('first.one', a);
  const occurrence = call.addReference('first.many', a);
  view.save(waiting, { current: 'a' });
  const cold = reopen();
  cold.view.verifySaved(store.readHead(owner.contextId));
  assert.throws(() => cold.view.replaceSelection('first.many', [a, wrong]), /another definition/);
  assert.throws(() => cold.view.replaceSelection('first.many', a), /cardinality/);
  assert.throws(() => cold.view.replaceSelection('first.one', [a]), /cardinality/);
  assert.equal(cold.call.referenceSize('first.many'), 1);
  assert.ok(cold.call.referenceEntry('first.many', occurrence));
  assert.throws(() => cold.view.save(accepted, { ids: ['a'] }), /Inactive selection/);
});

test('a second cold restore uses only latest point layout, not older successful verification coverage', (t) => {
  const { call, view, child, waiting, accepted, store, owner, reopen } = setup(t);
  const a = child('a');
  call.reference('first.one', a);
  view.save(waiting, { current: 'a' });
  const first = reopen();
  first.view.verifySaved(store.readHead(owner.contextId));
  first.view.replaceSelection('first.many', [a]);
  first.view.save(accepted, { ids: ['a'] });
  const second = reopen();
  second.view.verifySaved(store.readHead(owner.contextId));
  assert.throws(() => second.view.save(waiting, { current: 'a' }), /Inactive selection/);
});

test('direct save invalidates continuation until that exact new saved envelope is verified', (t) => {
  const { call, view, idle, store, owner } = setup(t);
  view.save(idle, { idle: true });
  call.save('bypass', { bypass: true });
  assert.throws(() => view.save(idle, { idle: true }), /must be verified/);
  assert.throws(() => view.verifySaved(store.readHead(owner.contextId)), /point envelope/);
});

test('new pending facts cannot be used to validate an old saved point combination', (t) => {
  const { call, view, child, waiting, store, owner, reopen } = setup(t);
  call.reference('first.one', child('a'));
  view.save(waiting, { current: 'a' });
  const cold = reopen();
  cold.call.createChild('new', null, { position: 'first', contract: 'first@1' });
  assert.throws(() => cold.view.verifySaved(store.readHead(owner.contextId)), /new pending/);
});

for (const failure of ['async', 'then getter', 'reenter']) {
  test(`point ${failure} check cannot open a continuation or escape its query window`, (t) => {
    let exposed;
    let active;
    const { call, view, child, waiting, store, owner } = setup(t, ({ waiting }) => {
      waiting.check = (_, facts) => {
        exposed = facts;
        if (failure === 'async') return Promise.resolve();
        if (failure === 'then getter')
          return Object.defineProperty({}, 'then', {
            get() {
              throw new Error('then getter');
            },
          });
        active.replaceSelection('first.many', []);
      };
    });
    active = view;
    call.reference('first.one', child('a'));
    assert.throws(() => view.save(waiting, null), /synchronous|then getter|Reentrant/);
    assert.throws(() => exposed.children.values(), /window has ended/);
    assert.equal(store.readHead(owner.contextId), undefined);
  });
}

test('explicit order projection changes only author display, not source relation identity', (t) => {
  const { call, view, child, waiting } = setup(t, ({ config, waiting }) => {
    config.orderOffset = -1;
    waiting.check = (_, facts) => assert.equal(facts.references.follow.order, 0);
  });
  const a = child('a');
  call.reference('first.one', a);
  view.save(waiting, null);
  assert.equal(call.relation(a).identity.order, 1);
});

for (const operation of ['save', 'check', 'replace', 'save options']) {
  test(`${operation} fixes author material under the source mutation lock`, (t) => {
    const { call, view, child, waiting, store, owner } = setup(t);
    const a = child('a');
    call.reference('first.one', a);
    view.save(waiting, { current: 'a' });
    const before = call.changes();
    const proxy = new Proxy(operation === 'replace' ? [a] : { current: 'a' }, {
      ownKeys(target) {
        call.save('injected', { bypass: true });
        return Reflect.ownKeys(target);
      },
    });
    assert.throws(() => {
      if (operation === 'save') view.save(waiting, proxy);
      else if (operation === 'check') view.check(waiting, proxy);
      else if (operation === 'replace') view.replaceSelection('first.many', proxy);
      else view.save(waiting, { current: 'a' }, proxy);
    }, /Reentrant/);
    assert.equal(store.readHead(owner.contextId).revision, 1);
    assert.deepEqual(call.changes(), before);
    assert.equal(call.referenceSize('first.many'), 0);
  });
}
