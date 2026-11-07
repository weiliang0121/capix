import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { StableValues } from './stable.mjs';
import { SavedFacts } from './saved-facts.mjs';

// Fresh-process composition: full stored-fact restoration, then the ORIGINAL
// head's point/state check, and only then another save. Not production resume.
const [mode, path, scenario = 'valid'] = process.argv.slice(2);
const store = new FactStore(path);
const owner = identity('parent');
const definition = Object.freeze({ name: 'child' });
const other = Object.freeze({ name: 'other' });
const reception = { key: 'saved-facts-recovery', version: 1, childPosition: 'child', check: (value) => assert.equal(value.step, 1), codec: { encode: (value) => value, decode: (value) => value } };
const options = {
  definitions: [
    { definition, position: 'child', contract: 'study@1' },
    { definition: other, position: 'other', contract: 'other@1' },
  ],
  receptions: [{ reception, contract: reception }],
  slots: { active: { cardinality: 'one', definition }, history: { cardinality: 'many', definition } },
};
let call;
let view;
let authorChecks = 0;
let continued = false;

function check(state, facts, point) {
  authorChecks++;
  // Deliberately unread selection controls test independent mechanism checks.
  if (scenario.startsWith('unread-')) return;
  assert.ok(['accepted', 'handled'].includes(point), 'Unknown original point');
  assert.equal(state.phase, point, 'State belongs to another point');
  const active = facts.references.active;
  assert.equal(active.input.step, state.step, 'Saved state selected another input');
  assert.equal(facts.children.require(definition, active.ref), active);
  assert.equal(facts.selections.entry('history', state.occurrence).child, active, 'Selected occurrence changed');
  const value = point === 'handled' ? facts.children.handled(active.ref, reception) : facts.children.accepted(active.ref, reception);
  assert.equal(value.step, state.step, 'Saved reception differs from state');
}

function report(status, error) {
  writeSync(1, `${JSON.stringify({ status, error: error?.message, authorChecks, continued, reception: call ? { ...call.stats } : null, view: view ? { ...view.stats } : null, store: { ...store.stats }, revision: store.readHead('parent')?.revision ?? null })}\n`);
}

try {
  if (mode === 'run') {
    call = new ReceptionEvidenceCall(store, owner, { fixed: true }, { contracts: [reception] });
    const child = call.createChild('child', { step: 1 });
    if (scenario === 'unread-cardinality') call.addReference('active', child);
    else call.reference('active', child);
    const occurrence = call.addReference('history', child);
    const phase = scenario === 'handled' ? 'handled' : 'accepted';
    if (phase === 'handled') call.failed(child, { message: 'business failure' });
    else call.returned(child, { step: 1 });
    call.establish(child, phase, { step: 1 }, reception);
    if (scenario === 'unread-target') {
      const foreignPosition = call.createChild('other', { step: 1 }, { position: 'other', contract: 'other@1' });
      call.reference('active', foreignPosition);
    }
    if (scenario === 'unread-missing') call.clearReference('active');
    if (scenario === 'unread-extra') call.reference('undeclared', child);
    const state = { phase, step: 1, occurrence };
    if (scenario.startsWith('unread-')) {
      // Fault fixture intentionally bypasses declaration validation to place a
      // structurally valid but declaration-incompatible selection on disk.
      call.save(phase, state);
    } else {
      view = new SavedFacts(call, options);
      view.save(phase, state, { check });
    }
    report('cut');
    process.exit(73);
  } else if (mode === 'resume') {
    const head = store.readHead(owner.contextId);
    call = ReceptionEvidenceCall.reopen(store, owner, { contracts: [reception] });
    // This fixture knows its existing reception-evidence-study@1 state codec.
    // Decoding does not replace the full Store/reception validation above.
    const envelope = new StableValues().decode(head.state);
    assert.equal(envelope.type, 'plain');
    const state = envelope.value;
    view = new SavedFacts(call, options);
    view.check(head.point, state, check);
    continued = true;
    view.save(head.point, state, { check });
    report('completed');
  } else throw new Error('Unknown fixture mode');
} catch (error) {
  report('rejected', error);
} finally {
  store.close();
}
