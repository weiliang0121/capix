import assert from 'node:assert/strict';
import { FactCall, runPointCheck } from './fact-call.mjs';
import { identity, stableCodec } from './fact-store.mjs';
import { StableValues } from './stable.mjs';

// Executable author-contract probes. These are not public Work/point APIs and
// do not replace the production ToolLoop or its external receipt validation.
export const toolContract = 'author-tool@1';
export const proposalContract = 'author-proposal@1';
export const applicationContract = 'author-application@1';

export function coldFacts(call) {
  return Object.freeze({
    input: () => call.input,
    value: (id) => call.value(id),
    material: (id) => call.material(id),
    relation: (child) => call.relation(child),
    allRelations: () => call.allRelations(),
    referenceOf: (slot) => call.referenceOf(slot),
    references: (slot) => call.references(slot),
    referenceSize: (slot) => call.referenceSize(slot),
    hasReference: (slot, child) => call.hasReference(slot, child),
    relationCount: (position, contract) => call.relationCount(position, contract),
    latestRelation: (position, contract) => call.latestRelation(position, contract),
    // Cold validation is a different scope, not an empty incremental history.
    changes: () => Object.freeze({ mode: 'restored', baseRevision: null, events: Object.freeze([]) }),
  });
}

// Full storage validation precedes the current point's business check. No
// resumed body runs before both succeed. We do not save a new head to validate.
export function restorePoint(store, owner, contract, points) {
  const values = new StableValues();
  const codec = stableCodec(values);
  const codecs = new Map([[codec.key, codec]]);
  const restored = store.restore(owner, codecs);
  assert.equal(restored.head.identity.contract, contract, 'Author contract changed');
  assert.equal(restored.head.status, 'active', 'Terminal call cannot resume');
  const check = points[restored.head.point];
  assert.equal(typeof check, 'function', 'Unknown author point');
  const call = new FactCall(store, restored.head.identity, undefined, { values, codec, codecs, restored });
  const state = values.own(restored.state);
  runPointCheck(check, state, coldFacts(call));
  return { call, state, point: restored.head.point };
}

function assertToolRelation(relation, exchange, facts) {
  assert.equal(relation.identity.position, 'tool');
  assert.equal(relation.identity.contract, toolContract);
  const input = facts.value(relation.input);
  assert.equal(input.exchange, exchange);
  if (relation.phase === 'accepted' || relation.phase === 'handled') {
    const accepted = facts.value(relation.received);
    assert.equal(accepted.exchange, input.exchange);
    assert.equal(accepted.slot, input.slot);
    assert.equal(accepted.status, relation.phase === 'accepted' ? 'ok' : 'error');
  }
}

// Representative of one ToolLoop exchange: repeated tool declaration,
// waiting/handled, exact active role and a rejection without any child. The
// complete production exchange-prefix/receipt policy is deliberately NOT mocked.
export function checkTools(state, facts) {
  assert.equal(state.exchange, 'exchange-1');
  assert.ok(Number.isSafeInteger(state.cursor) && state.cursor >= 0);
  if (state.rejection) {
    const rejection = facts.value(state.rejection);
    assert.deepEqual(rejection, { exchange: state.exchange, slot: 2, status: 'rejected' });
  }
  const changes = facts.changes();
  if (changes.mode === 'restored') {
    for (const relation of facts.allRelations()) assertToolRelation(relation, state.exchange, facts);
    for (const child of facts.references('tools')) assertToolRelation(facts.relation(child), state.exchange, facts);
  } else {
    for (const event of changes.events) {
      if (event.type === 'relation') assertToolRelation(event.value, state.exchange, facts);
      if (event.type === 'ref-add') {
        assert.equal(event.slot, 'tools');
        assertToolRelation(facts.relation(event.value), state.exchange, facts);
      }
    }
  }
  if (state.phase === 'waiting') {
    const active = facts.referenceOf('active');
    assert.ok(active, 'Missing active role');
    const relation = facts.relation(active);
    assert.equal(relation.phase, 'waiting');
    assertToolRelation(relation, state.exchange, facts);
    assert.equal(facts.value(relation.input).slot, state.cursor, 'Active instance differs from cursor');
    assert.equal(facts.hasReference('tools', active), true, 'Active role omitted from collection');
  } else {
    assert.equal(state.phase, 'processing');
    assert.equal(facts.referenceOf('active'), undefined, 'Processing still has active role');
  }
}

export function seedTools(store) {
  const call = new FactCall(store, identity('tools', null, 'root', 0, 'author-tools@1'), { exchange: 'exchange-1' });
  const first = call.createChild('tool-1', { exchange: 'exchange-1', slot: 0 }, { position: 'tool', contract: toolContract });
  call.addReference('tools', first);
  call.returned(first, { text: 'first' });
  call.receive(first, { exchange: 'exchange-1', slot: 0, status: 'ok' });
  call.save('processing', { exchange: 'exchange-1', cursor: 1, phase: 'processing' }, { check: checkTools });
  const second = call.createChild('tool-2', { exchange: 'exchange-1', slot: 1 }, { position: 'tool', contract: toolContract });
  call.addReference('tools', second);
  call.failed(second, { message: 'ordinary business failure' });
  call.receive(second, { exchange: 'exchange-1', slot: 1, status: 'error' });
  call.save('processing', { exchange: 'exchange-1', cursor: 2, phase: 'processing' }, { check: checkTools });
  // Rejected slot 2 creates no Invocation. Its business feedback is a local
  // fixed material; this is not a synthetic failed child.
  const rejection = call.capture({ exchange: 'exchange-1', slot: 2, status: 'rejected' });
  call.save('processing', { exchange: 'exchange-1', cursor: 3, phase: 'processing', rejection }, { check: checkTools });
  const active = call.createChild('tool-3', { exchange: 'exchange-1', slot: 3 }, { position: 'tool', contract: toolContract });
  call.addReference('tools', active);
  call.reference('active', active);
  const state = { exchange: 'exchange-1', cursor: 3, phase: 'waiting', rejection };
  call.save('waiting', state, { check: checkTools });
  return { call, first, second, active, state };
}

// No named refs are required. Exact indexed query of a historical handled
// child is still necessary after its temporary role has been cleared.
export function checkMaintenance(state, facts) {
  assert.equal(facts.relationCount('propose', proposalContract), 1);
  const proposal = facts.latestRelation('propose', proposalContract);
  assert.ok(proposal);
  const outcome = facts.value(proposal.received);
  if (state.status === 'skipped') {
    assert.equal(facts.relationCount(), 1, 'Skipped branch has unexpected children');
    assert.equal(proposal.result, 'failed');
    assert.equal(proposal.phase, 'handled');
    assert.equal(outcome.status, 'skipped');
    assert.equal(facts.relationCount('apply', applicationContract), 0, 'Skipped branch cannot apply');
  } else {
    assert.equal(state.status, 'ready');
    assert.equal(proposal.phase, 'accepted', 'Ready requires successful proposal');
    assert.equal(outcome.status, 'ready');
    assert.equal(facts.relationCount(), 2, 'Completed ready branch requires exactly proposal and apply');
    assert.equal(facts.relationCount('apply', applicationContract), 1);
    const application = facts.latestRelation('apply', applicationContract);
    assert.equal(application.phase, 'accepted');
    assert.deepEqual(facts.value(application.input), { changes: outcome.changes });
    assert.deepEqual(facts.value(application.output), facts.value(application.received));
  }
}

export function seedMaintenance(store) {
  const call = new FactCall(store, identity('maintenance', null, 'root', 0, 'author-maintenance@1'), { message: 4 });
  const child = call.createChild('proposal', { message: 4 }, { position: 'propose', contract: proposalContract });
  call.reference('proposal', child);
  call.save('proposalWaiting', { status: 'waiting' });
  call.failed(child, { message: 'invalid proposal' });
  call.receive(child, { status: 'skipped' });
  call.clearReference('proposal');
  call.save('completed', { status: 'skipped' }, { check: checkMaintenance });
  return { call, child };
}

export function checkCaptured(state, facts) {
  const material = facts.material(state.material);
  assert.equal(state.source, facts.input().source, 'Captured material differs from original input');
  assert.equal(material.source, state.source);
  assert.equal(material.version, state.version);
  assert.equal(typeof material.text, 'string');
}

export function seedCapture(store, text = 'old entity value') {
  const call = new FactCall(store, identity('capture', null, 'root', 0, 'author-capture@1'), { source: 'file-1' });
  const raw = { source: 'file-1', version: 7, text };
  const material = call.capture(raw);
  const state = { source: 'file-1', version: 7, material };
  call.save('captured', state, { check: checkCaptured });
  raw.version = 8;
  raw.text = 'entity changed after capture';
  return { call, state, raw };
}
