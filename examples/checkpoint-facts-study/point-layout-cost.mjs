import assert from 'node:assert/strict';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { PointFacts } from './point-facts.mjs';

const delta = (after, before) => Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value - (before[name] ?? 0)]));

// Isolated, deterministic work counters. This does not time production Frame v5.
export function measurePointLayouts({ children, switches = 32 }) {
  const store = new FactStore();
  const definition = Object.freeze({ name: 'child' });
  const reception = { key: 'point-layout.value', version: 1, childPosition: 'child', check: (value) => assert.ok(Number.isSafeInteger(value.step)), codec: { encode: (value) => value, decode: (value) => value } };
  const call = new ReceptionEvidenceCall(store, identity('parent'), { query: 'fixed' }, { contracts: [reception] });
  let authorChecks = 0;
  function checkCurrent(alias, state, facts) {
    authorChecks++;
    const fact = facts.references[alias];
    assert.equal(facts.children.accepted(fact.ref, reception).step, state.step);
    assert.equal(facts.selections.size('history'), state.step);
    assert.deepEqual(Object.keys(facts.references).sort(), [alias, 'history'].sort());
  }
  const first = { name: 'first', version: 1, slots: { child: 'active-source', history: 'history-source' }, check: (state, facts) => checkCurrent('child', state, facts) };
  const second = { name: 'second', version: 1, slots: { result: 'active-source', history: 'history-source' }, check: (state, facts) => checkCurrent('result', state, facts) };
  const empty = {
    name: 'empty',
    version: 1,
    slots: {},
    check(_, facts) {
      authorChecks++;
      assert.deepEqual(Object.keys(facts.references), []);
    },
  };
  const view = new PointFacts(call, { definitions: [{ definition, position: 'child', contract: 'study@1' }], sources: { 'active-source': { cardinality: 'one', definition }, 'history-source': { cardinality: 'many', definition } }, points: [first, second, empty] });
  try {
    for (let step = 1; step <= children; step++) {
      const child = call.createChild(`child-${step}`, { step });
      call.returned(child, { step });
      call.establish(child, 'accepted', { step }, reception);
      call.addReference('history-source', child);
      call.reference('active-source', child);
      view.save(step % 2 ? first : second, { step });
      view.save(empty, { step });
    }
    const growth = { view: { ...view.stats }, facts: { ...call.factStats }, receptions: { ...call.stats }, store: { ...store.stats }, authorChecks };
    const beforeView = { ...view.stats };
    const beforeCall = { ...call.stats };
    const beforeFacts = { ...call.factStats };
    const beforeStore = { ...store.stats };
    const beforeChecks = authorChecks;
    for (let index = 0; index < switches; index++) view.save([first, second, empty][index % 3], { step: children });
    const switched = { view: delta(view.stats, beforeView), facts: delta(call.factStats, beforeFacts), receptions: delta(call.stats, beforeCall), store: delta(store.stats, beforeStore), authorChecks: authorChecks - beforeChecks };
    return { children, switches, growth, switched };
  } finally {
    store.close();
  }
}
