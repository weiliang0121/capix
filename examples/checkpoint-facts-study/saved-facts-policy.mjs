import assert from 'node:assert/strict';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { SavedFacts } from './saved-facts.mjs';

const contractName = (definition) => `${definition.checkpoint.key}@${definition.checkpoint.version}`;

/**
 * Import a fixture ONCE into the existing experimental call, then ask the real
 * ToolLoop point.check to consume its lazy facts. Snapshot loading is a cold
 * adapter cost, not an incremental algorithm or a second invocation state.
 * Hot progression uses append/settle commands against that same call.
 */
export function createSavedToolPolicy(fixture, snapshot) {
  const store = new FactStore();
  const definitions = [fixture.definitions.model, fixture.definitions.read];
  const originalReceptions = definitions.map((definition) => fixture.loop.checkpoint.receptions.find((reception) => reception.child === definition));
  const contracts = originalReceptions.map((reception, position) => ({
    key: `${fixture.loop.checkpoint.key}.reception.${position}`,
    version: fixture.loop.checkpoint.version,
    childPosition: String(position),
    check: reception.value.check.bind(reception.value),
    codec: { encode: reception.value.encode.bind(reception.value), decode: reception.value.decode.bind(reception.value) },
  }));
  const owner = identity(snapshot.parentId, null, 'root', 0, contractName(fixture.loop));
  const call = new ReceptionEvidenceCall(store, owner, snapshot.input, { contracts });
  const configuration = {
    definitions: definitions.map((definition, position) => ({ definition, position: String(position), contract: contractName(definition) })),
    slots: { models: { cardinality: 'many', definition: definitions[0] }, read: { cardinality: 'many', definition: definitions[1] } },
    receptions: originalReceptions.map((reception, position) => ({ reception, contract: contracts[position] })),
  };
  const facts = new SavedFacts(call, configuration);
  // This maps external fixture names to exact call-owned identities. It carries
  // no copies of input/output/reception state and never drives relation state.
  const identities = new Map();
  const loading = { coldRelations: 0, coldReferenceOccurrences: 0, coldSettlements: 0, hotAppends: 0, hotSettlements: 0, explicitReferenceRewrites: 0 };
  let cold = true;

  function validateIdentity(record) {
    const position = record.identity.position;
    assert.equal(record.identity.parentId, owner.contextId, 'Fixture child belongs to another owner');
    assert.ok(Number.isSafeInteger(position) && definitions[position], 'Fixture child has an unknown position');
    assert.deepEqual(record.identity.contract, { key: definitions[position].checkpoint.key, version: definitions[position].checkpoint.version }, 'Fixture child contract changed');
    assert.equal(record.ref.contextId, record.identity.contextId, 'Fixture reference names another child');
    assert.equal(record.parentRound, 1, 'Fixture child has another parent round');
    assert.equal(record.order, record.identity.order, 'Fixture child order changed');
    return position;
  }

  function child(id) {
    const value = identities.get(id);
    assert.ok(value, 'Fixture reference names an unknown child');
    return value;
  }

  function append(record, { select = true } = {}) {
    const position = validateIdentity(record);
    assert.equal(record.identity.order, identities.size, 'Fixture creation order is not contiguous');
    assert.ok(!identities.has(record.identity.contextId), 'Duplicate fixture child identity');
    const created = call.createChild(record.identity.contextId, record.input, { position: String(position), contract: contractName(definitions[position]), key: record.key });
    // FactCall uses 1-based order; the production fixture is 0-based. The one
    // global offset preserves every relative-order assertion of ToolLoop.
    assert.equal(created.order, record.identity.order + 1);
    identities.set(created.contextId, created);
    if (select) call.addReference(position === 0 ? 'models' : 'read', created);
    loading[cold ? 'coldRelations' : 'hotAppends']++;
    return created;
  }

  function settle(record) {
    const position = validateIdentity(record);
    const target = child(record.identity.contextId);
    assert.equal(target.order, record.identity.order + 1, 'Fixture settled another child occurrence');
    assert.equal(target.position, String(position));
    const relation = call.relation(target);
    assert.equal(relation.key, record.key, 'Fixture settlement changed the fixed child key');
    assert.deepEqual(call.factValue(relation.input), record.input, 'Fixture settlement changed fixed child input');
    if (record.returned?.status === 'succeeded') call.returned(target, record.returned.output);
    else if (record.returned?.status === 'failed') call.failed(target, record.returned.diagnostic);
    else assert.fail('Fixture settlement has no returned outcome');
    if (record.reception.status === 'accepted' || record.reception.status === 'handled') call.establish(target, record.reception.status, record.reception.value, contracts[position]);
    else assert.equal(record.reception.status, 'pending');
    loading[cold ? 'coldSettlements' : 'hotSettlements']++;
  }

  function replaceReferences(slot, references) {
    // Arbitrary replacement is intentionally explicit author work, not a
    // hidden per-save operation. Ordered duplicate occurrences are preserved.
    assert.ok(Object.hasOwn(configuration.slots, slot), 'Unknown fixture reference slot');
    for (const occurrence of call.referenceEntries(slot)) call.removeReference(slot, occurrence.id);
    for (const reference of references) call.addReference(slot, child(reference.contextId));
    loading.explicitReferenceRewrites++;
  }

  function point(name) {
    const declaration = fixture.points.get(name);
    assert.ok(declaration, 'Unknown ToolLoop checkpoint point');
    return declaration;
  }

  try {
    for (const record of snapshot.records) {
      append(record, { select: false });
      if (record.returned) settle(record);
      else assert.equal(record.reception.status, 'pending', 'Reception cannot precede return');
    }
    for (const [slot, references] of Object.entries(snapshot.refs)) {
      assert.ok(Object.hasOwn(configuration.slots, slot), 'Unknown fixture reference slot');
      for (const reference of references) {
        call.addReference(slot, child(reference.contextId));
        loading.coldReferenceOccurrences++;
      }
    }
    cold = false;
  } catch (error) {
    store.close();
    throw error;
  }

  return {
    call,
    facts,
    store,
    owner,
    contracts,
    configuration,
    loading,
    child,
    append,
    settle,
    replaceReferences,
    check: (name, state) => facts.check(name, state, point(name).check),
    save: (name, state, options = {}) => facts.save(name, state, { ...options, check: point(name).check }),
    reopen() {
      const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts });
      return { call: restored, facts: new SavedFacts(restored, configuration) };
    },
    close: () => store.close(),
  };
}

/** Fixture preparation is outside the measured save path. Each command below
 * addresses one newly created/settled relation; no history diff is performed. */
export const toolPolicyTimeline = Object.freeze([
  ['waiting-model', null, null],
  ['received-model', 'settle', 'model-0'],
  ['waiting-tool', 'append', 'tool-0'],
  ['accepted-tool', 'settle', 'tool-0'],
  ['rejected-precheck', null, null],
  ['waiting-handled-tool', 'append', 'tool-1'],
  ['handled-tool', 'settle', 'tool-1'],
  ['next-model-waiting', 'append', 'model-1'],
  ['second-received-model', 'settle', 'model-1'],
  ['repeated-key-waiting-tool', 'append', 'tool-2'],
  ['repeated-key-accepted-tool', 'settle', 'tool-2'],
  ['final-model-waiting', 'append', 'model-2'],
  ['final', 'settle', 'model-2'],
]);
