import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { PointFacts } from './point-facts.mjs';
import { StableValues } from './stable.mjs';

const [mode, path, scenario = 'valid'] = process.argv.slice(2);
const store = new FactStore(path);
const owner = identity('parent');
const definition = Object.freeze({ name: 'child' });
const other = Object.freeze({ name: 'other' });
const reception = { key: 'point-layout.accepted', version: 1, childPosition: 'child', check: (value) => assert.ok([1, 2].includes(value.step)), codec: { encode: (value) => value, decode: (value) => value } };
let authorChecks = 0;
let continued = false;
let inactiveRejected = false;
let preverifyRejected = false;
let call;
let view;
const one = {
  name: 'one',
  version: 1,
  slots: { follow: 'single' },
  check(state, facts) {
    authorChecks++;
    assert.equal(facts.references.follow.input.step, state.expected, 'Original single state differs');
  },
};
const many = {
  name: 'many',
  version: mode === 'resume' && scenario === 'point-version' ? 2 : 1,
  slots: { follow: mode === 'resume' && scenario === 'source-map' ? 'spare-many' : 'many' },
  check(state, facts) {
    authorChecks++;
    assert.equal(facts.references.follow.length, state.count, 'Original many count differs');
    assert.equal(facts.references.follow[0].input.step, state.expected, 'Original many state differs');
  },
};
const empty = {
  name: 'empty',
  version: 1,
  slots: {},
  check(state, facts) {
    authorChecks++;
    assert.equal(state.allowed, true);
    assert.deepEqual(Object.keys(facts.references), []);
  },
};
if (mode === 'resume' && scenario === 'alias-map') many.slots = { renamed: 'many' };
const configuration = {
  definitions: [
    { definition, position: 'child', contract: 'study@1' },
    { definition: other, position: 'other', contract: 'other@1' },
  ],
  sources: { single: { cardinality: 'one', definition }, many: { cardinality: mode === 'resume' && scenario === 'cardinality' ? 'one' : 'many', definition: mode === 'resume' && scenario === 'target' ? other : definition }, 'spare-many': { cardinality: 'many', definition } },
  points: [one, many, empty],
};
if (mode === 'resume' && scenario === 'decoder-reentry')
  configuration.decodeState = (head) => {
    call.save('unverified-raw-head', { notChecked: true });
    return new StableValues().decode(head.state).value;
  };

function report(status, error) {
  writeSync(1, `${JSON.stringify({ status, error: error?.message, authorChecks, continued, inactiveRejected, preverifyRejected, reception: call?.stats, queries: view?.stats, store: store.stats, revision: store.readHead(owner.contextId)?.revision })}\n`);
}

try {
  if (mode === 'run') {
    call = new ReceptionEvidenceCall(store, owner, { fixed: true }, { contracts: [reception] });
    const first = call.createChild('child-1', { step: 1 });
    const second = call.createChild('child-2', { step: 2 });
    for (const [child, step] of [
      [first, 1],
      [second, 2],
    ]) {
      call.returned(child, { step });
      call.establish(child, 'accepted', { step }, reception);
    }
    call.reference('single', first);
    for (const child of [first, first, second]) call.addReference('many', child);
    call.addReference('spare-many', second);
    view = new PointFacts(call, configuration);
    view.save(one, { expected: 1 });
    view.save(many, { expected: 1, count: 3 });
    if (scenario === 'empty-head') view.save(empty, { allowed: true });
    report('cut');
    process.exit(73);
  } else if (mode === 'resume') {
    const head = store.readHead(owner.contextId);
    call = ReceptionEvidenceCall.reopen(store, owner, { contracts: [reception] });
    view = new PointFacts(call, configuration);
    if (scenario === 'preverify') {
      assert.throws(() => view.save(empty, { allowed: true }));
      assert.equal(authorChecks, 0, 'Another point cannot replace the original qualification');
      preverifyRejected = true;
    }
    const supplied = scenario === 'counterfeit-head' ? { ...head, point: 'empty' } : head;
    view.verifySaved(supplied);
    if (scenario === 'inactive' || scenario === 'empty-head') {
      const before = authorChecks;
      assert.throws(() => view.save(one, { expected: 1 }));
      assert.equal(authorChecks, before, 'Uncovered saved selection is not exposed to the author');
      inactiveRejected = true;
      const second = identity('child-2', 'parent', 'child', 2, 'study@1');
      view.replaceSelection('single', second);
      view.save(one, { expected: 2 });
    } else view.save(many, { expected: 1, count: 3 });
    continued = true;
    report('completed');
  } else throw new Error('Unknown fixture mode');
} catch (error) {
  report('rejected', error);
} finally {
  store.close();
}
