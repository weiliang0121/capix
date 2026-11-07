import assert from 'node:assert/strict';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { SavedFacts } from './saved-facts.mjs';

const difference = (after, before) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]));

// Counts compare query strategies on the SAME fact model, not production-v5
// elapsed time. The eager control explicitly constructs every relation wrapper.
export function measureSavedFacts({ children, mode = 'current', eager = false }) {
  const store = new FactStore();
  const definition = Object.freeze({ name: 'study child' });
  const reception = {
    key: 'study.saved-facts.reception',
    version: 1,
    childPosition: 'child',
    check(value) {
      assert.ok(Number.isSafeInteger(value.step) && value.step > 0);
      assert.equal(typeof value.text, 'string');
    },
    codec: { encode: (value) => value, decode: (value) => value },
  };
  const call = new ReceptionEvidenceCall(store, identity('parent'), { material: 'h'.repeat(1024) }, { contracts: [reception] });
  const view = new SavedFacts(call, {
    definitions: [{ definition, position: 'child', contract: 'study@1' }],
    receptions: [{ reception, contract: reception }],
    slots: { active: { cardinality: 'one', definition }, history: { cardinality: 'many', definition } },
  });
  let authorRows = 0;
  let authorChecks = 0;
  const samples = [];
  function check(state, facts) {
    authorChecks++;
    if (eager) facts.children.values();
    if (mode === 'none') return;
    if (mode === 'all') {
      for (const fact of facts.children.values()) {
        authorRows++;
        assert.ok(fact.input.step > 0);
      }
    }
    const active = facts.references.active;
    assert.equal(facts.children.require(definition, active.ref), active);
    assert.equal(active.input.step, state.step);
    const entry = facts.selections.entry('history', state.occurrence);
    assert.equal(entry.child, active);
    if (state.phase === 'waiting') assert.equal(active.returned, undefined);
    else assert.equal(facts.children.accepted(active.ref, reception).step, state.step);
  }
  function save(state) {
    const beforeView = { ...view.stats };
    const beforeFacts = { ...call.factStats };
    const beforeReception = { ...call.stats };
    view.save(state.phase, state, { check });
    samples.push({ step: state.step, phase: state.phase, view: difference(view.stats, beforeView), facts: difference(call.factStats, beforeFacts), reception: difference(call.stats, beforeReception) });
  }
  try {
    let last;
    for (let step = 1; step <= children; step++) {
      const child = call.createChild(`child-${step}`, { step });
      call.reference('active', child);
      const occurrence = call.addReference('history', child);
      save({ step, phase: 'waiting', occurrence });
      call.returned(child, { step, text: 'result' });
      call.establish(child, 'accepted', { step, text: 'accepted' }, reception);
      last = { step, phase: 'accepted', occurrence };
      save(last);
    }
    const result = { config: { children, mode, eager }, saves: samples.length, view: { ...view.stats }, facts: { ...call.factStats }, reception: { ...call.stats }, store: { ...store.stats }, authorChecks, authorRows, samples: [...samples] };
    const beforeView = { ...view.stats };
    const beforeReception = { ...call.stats };
    const beforeFacts = { ...call.factStats };
    const beforeStore = { ...store.stats };
    save(last);
    return { ...result, noNewFacts: { view: difference(view.stats, beforeView), reception: difference(call.stats, beforeReception), facts: difference(call.factStats, beforeFacts), store: difference(store.stats, beforeStore) } };
  } finally {
    store.close();
  }
}
