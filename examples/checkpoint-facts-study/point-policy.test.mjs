import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { PointFacts } from './point-facts.mjs';
import { createContentPointFixture, createPointPolicyProbe, createRequestPointFixture, createScenePointFixture } from './point-policy.mjs';

const fixtures = [
  ['RequestModel pending one-to-many', () => createRequestPointFixture()],
  ['RequestModel direct empty many', () => createRequestPointFixture({ direct: true })],
  ['ContentMaintenance one-empty-other-empty', createContentPointFixture],
  ['Conversation Scene same alias different targets', createScenePointFixture],
];

for (const [name, make] of fixtures) {
  test(`actual service point.check remains unchanged through ${name}`, (t) => {
    const fixture = make();
    const probe = createPointPolicyProbe(fixture);
    t.after(probe.close);
    for (const stage of fixture.stages) {
      assert.doesNotThrow(() => fixture.check(stage), `Original ${stage.name}`);
      assert.doesNotThrow(() => probe.save(stage), `Projected ${stage.name}`);
    }
    const last = fixture.stages.at(-1);
    const before = { ...probe.call.stats };
    probe.facts.save(probe.points.get(last.name), last.state);
    assert.equal(probe.call.stats.receptionEncode - before.receptionEncode, 0);
    assert.equal(probe.call.stats.persistenceCheck - before.persistenceCheck, 0);
  });

  test(`actual saved point is verified before continuation at every stage of ${name}`, () => {
    const fixture = make();
    const probe = createPointPolicyProbe(fixture);
    try {
      for (const stage of fixture.stages) {
        probe.save(stage);
        const restored = probe.reopen();
        assert.doesNotThrow(() => restored.facts.verifySaved(probe.store.readHead(probe.owner.contextId)), stage.name);
        assert.doesNotThrow(() => restored.facts.check(probe.points.get(stage.name), stage.state));
        assert.equal(restored.call.stats.receptionEncode, 0);
      }
    } finally {
      probe.close();
    }
  });
}

test('RequestModel registers follow as one and many on distinct real points', (t) => {
  const fixture = createRequestPointFixture();
  assert.equal(fixture.points.get('followWaiting').references.follow.many, false);
  assert.equal(fixture.points.get('feedbackAccepted').references.follow.many, true);
  assert.equal(fixture.points.get('followWaiting').references.follow.definition, fixture.points.get('feedbackAccepted').references.follow.definition);
  const probe = createPointPolicyProbe(fixture);
  t.after(probe.close);
  for (const stage of fixture.stages) probe.save(stage);
  const single = probe.points.get('followWaiting').slots.follow;
  const many = probe.points.get('feedbackAccepted').slots.follow;
  assert.notEqual(single, many, 'Explicit sources have distinct cardinality; no implicit coercion');
  assert.deepEqual(probe.call.referenceOf(single), probe.child('follow'));
  assert.deepEqual(
    probe.call.referenceEntries(many).map((entry) => entry.child),
    [probe.child('follow')],
  );
});

test('an empty current projection preserves old relations and does not expose retained source choices', (t) => {
  const fixture = createContentPointFixture();
  const probe = createPointPolicyProbe(fixture);
  t.after(probe.close);
  probe.save(fixture.stages[0]);
  const oldSource = probe.points.get('messageWaiting').slots.include;
  probe.save(fixture.stages[1]);
  assert.deepEqual(probe.points.get('messageIncluded').slots, {});
  assert.deepEqual(probe.call.referenceOf(oldSource), probe.child('include'), 'Not selecting an old source is not a rule to delete it');
  assert.equal(probe.call.relation(probe.child('include')).phase, 'accepted');
  probe.save(fixture.stages[2]);
  probe.save(fixture.stages[3]);
  assert.deepEqual(probe.points.get('completed').slots, {});
  assert.equal(probe.call.relationCount(), 2);
});

test('ContentMaintenance verifies its empty saved point before explicitly selecting the next child', (t) => {
  const fixture = createContentPointFixture();
  const probe = createPointPolicyProbe(fixture);
  t.after(probe.close);
  probe.save(fixture.stages[0]);
  probe.save(fixture.stages[1]);
  const restored = probe.reopen();
  const nextPoint = probe.points.get('memoryWaiting');
  assert.throws(() => restored.facts.save(nextPoint, undefined), /Original saved checkpoint must be verified/);
  const saved = restored.facts.verifySaved(probe.store.readHead(probe.owner.contextId));
  assert.equal(saved.point, probe.points.get('messageIncluded'));
  assert.equal(saved.state, undefined);
  const next = fixture.stages[2].events[0].record;
  const child = restored.call.createChild(next.id, next.input, { position: String(next.position), contract: `${fixture.definitions[next.position].checkpoint.key}@${fixture.definitions[next.position].checkpoint.version}`, key: next.key });
  // The next role is explicitly established after the original empty point was
  // authenticated. Residual source choices are not implicit resume arguments.
  restored.facts.replaceSelection(nextPoint.slots.remember, child);
  restored.facts.save(nextPoint, undefined);
  restored.call.returned(child, undefined);
  restored.call.establish(child, 'accepted', undefined, probe.contracts[next.position]);
  restored.facts.save(probe.points.get('completed'), undefined);
});

test('Scene child roles follow the registered point, not an invocation-wide target for the name', (t) => {
  const fixture = createScenePointFixture();
  const probe = createPointPolicyProbe(fixture);
  t.after(probe.close);
  assert.notEqual(probe.points.get('beforeWaiting').slots.child, probe.points.get('prepareWaiting').slots.child);
  assert.notEqual(probe.points.get('prepareWaiting').slots.child, probe.points.get('answerWaiting').slots.child);
  assert.equal(probe.points.get('beforeWaiting').slots.child, probe.points.get('afterWaiting').slots.child, 'Sharing one source is an explicit choice for the same declaration/cardinality');
  for (const stage of fixture.stages) probe.save(stage);
  assert.deepEqual(probe.call.referenceOf(probe.points.get('afterWaiting').slots.child), probe.child('after'));
});

test('Scene cannot use the previous point target for its next child role', (t) => {
  const fixture = createScenePointFixture();
  const probe = createPointPolicyProbe(fixture);
  t.after(probe.close);
  probe.save(fixture.stages[0]);
  const next = fixture.stages[1];
  probe.apply(next.events);
  probe.select(next.name, { child: 'before' });
  assert.throws(() => probe.facts.save(probe.points.get(next.name), next.state));
});

const corruptions = [
  ['RequestModel pending input', () => createRequestPointFixture(), 1, (stage) => (stage.records.find((record) => record.id === 'follow').input.id = 'other-interaction')],
  ['RequestModel duplicate follow occurrence', () => createRequestPointFixture(), 2, (stage) => stage.refs.follow.push(stage.refs.follow[0])],
  [
    'ContentMaintenance received child at waiting point',
    createContentPointFixture,
    1,
    (stage) => {
      stage.name = 'messageWaiting';
      stage.refs = { include: 'include' };
    },
  ],
  ['Scene old same-declaration maintenance', createScenePointFixture, 4, (stage) => (stage.refs.child = 'before')],
  ['Scene changed accepted response', createScenePointFixture, 3, (stage) => (stage.state.response.message.content = 'changed')],
];

for (const [name, make, index, mutate] of corruptions) {
  test(`real policy rejection remains visible: ${name}`, () => {
    const fixture = make();
    const stage = structuredClone(fixture.stages[index]);
    mutate(stage);
    assert.throws(() => fixture.check(stage));
    // A fresh fixture call is populated by explicit prior transition commands.
    // Changed fixed inputs are imported as an adversarial cold candidate rather
    // than mutating a fact that the runtime has already established.
    const probe = createPointPolicyProbe(fixture);
    try {
      if (name === 'RequestModel pending input') {
        for (let current = 0; current <= index; current++) {
          const original = structuredClone(fixture.stages[current]);
          if (current === index) original.events.find((event) => event.kind === 'create' && event.record.id === 'follow').record.input.id = 'other-interaction';
          probe.apply(original.events);
        }
      } else {
        for (let current = 0; current <= index; current++) probe.apply(fixture.stages[current].events);
      }
      probe.select(stage.name, stage.refs);
      assert.throws(() => probe.facts.save(probe.points.get(stage.name), stage.state));
    } finally {
      probe.close();
    }
  });
}

function custom(t, history = 0) {
  const store = new FactStore();
  t.after(() => store.close());
  const a = Object.freeze({ name: 'a' });
  const b = Object.freeze({ name: 'b' });
  const call = new ReceptionEvidenceCall(store, identity('point-policy-custom'), { input: 'fixed' });
  for (let index = 0; index < history; index++) {
    const child = call.createChild(`history-${index}`, index, { position: 'b', contract: 'b@1' });
    call.addReference('history', child);
  }
  const current = (definition) => (_state, facts) => {
    const selected = facts.references.active;
    assert.equal(facts.children.require(definition, selected.ref).ref, facts.children.latest(definition).ref, 'Point must select the current occurrence');
  };
  const first = { name: 'a', version: 1, slots: { active: 'a' }, check: current(a) };
  const second = { name: 'b', version: 1, slots: { active: 'b' }, check: current(b) };
  const empty = { name: 'empty', version: 1, slots: {}, check: (_state, facts) => assert.deepEqual(Object.keys(facts.references), []) };
  const many = {
    name: 'many',
    version: 1,
    slots: { chosen: 'chosen' },
    check: (state, facts) =>
      assert.deepEqual(
        facts.references.chosen.map((child) => child.input),
        state,
      ),
  };
  const definitions = [
    { definition: a, position: 'a', contract: 'a@1' },
    { definition: b, position: 'b', contract: 'b@1' },
  ];
  const sources = { a: { definition: a, cardinality: 'one' }, b: { definition: b, cardinality: 'one' }, chosen: { definition: b, cardinality: 'many' }, history: { definition: b, cardinality: 'many' } };
  const facts = new PointFacts(call, { definitions, sources, points: [first, second, empty, many] });
  return { call, facts, first, second, empty, many };
}

test('returning to the same point explicitly selects its new child occurrence and rejects its old one', (t) => {
  const { call, facts, first, second } = custom(t);
  const a1 = call.createChild('a1', 1, { position: 'a', contract: 'a@1' });
  call.reference('a', a1);
  facts.save(first, null);
  const b1 = call.createChild('b1', 2, { position: 'b', contract: 'b@1' });
  call.reference('b', b1);
  facts.save(second, null);
  const a2 = call.createChild('a2', 3, { position: 'a', contract: 'a@1' });
  call.reference('a', a2);
  facts.save(first, null);
  call.reference('a', a1);
  assert.throws(() => facts.save(first, null), /current occurrence/);
});

test('many projection retains ordered duplicates when leaving and explicitly selecting it again', (t) => {
  const { call, facts, many, empty } = custom(t);
  const b1 = call.createChild('b1', 1, { position: 'b', contract: 'b@1' });
  const b2 = call.createChild('b2', 2, { position: 'b', contract: 'b@1' });
  call.addReference('chosen', b2);
  call.addReference('chosen', b1);
  call.addReference('chosen', b2);
  facts.save(many, [2, 1, 2]);
  facts.save(empty, null);
  for (const occurrence of call.referenceEntries('chosen')) call.removeReference('chosen', occurrence.id);
  call.addReference('chosen', b1);
  call.addReference('chosen', b1);
  call.addReference('chosen', b2);
  facts.save(many, [1, 1, 2]);
  assert.equal(call.relationCount(), 2, 'Selection changes never remove the underlying relations');
});

test('switching a bounded projection does not enumerate unselected historical relations or occurrences', (t) => {
  const { call, facts, first, second, empty } = custom(t, 128);
  const a = call.createChild('active-a', 1, { position: 'a', contract: 'a@1' });
  const b = call.createChild('active-b', 2, { position: 'b', contract: 'b@1' });
  call.reference('a', a);
  call.reference('b', b);
  facts.save(first, null);
  const beforeCall = { ...call.factStats };
  const before = { ...facts.stats };
  facts.save(second, null);
  facts.save(empty, null);
  facts.save(first, null);
  assert.equal(call.factStats.authoredScans - beforeCall.authoredScans, 0);
  assert.equal(call.factStats.referenceScans - beforeCall.referenceScans, 0);
  assert.equal(call.factStats.encodedFacts - beforeCall.encodedFacts, 0);
  assert.equal(facts.stats.wrappersBuilt - before.wrappersBuilt, 2);
});
