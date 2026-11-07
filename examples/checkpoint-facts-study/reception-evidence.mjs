import assert from 'node:assert/strict';
import { FactCall } from './fact-call.mjs';
import { StableValues } from './stable.mjs';

const format = 'reception-evidence-study@1';
const descriptorKey = (value) => JSON.stringify([value.key, value.version, value.childPosition]);

function descriptor(contract) {
  assert.equal(typeof contract.key, 'string');
  assert.ok(contract.key.length > 0);
  assert.ok(Number.isSafeInteger(contract.version) && contract.version > 0);
  assert.equal(typeof contract.childPosition, 'string');
  assert.ok(contract.childPosition.length > 0);
  return Object.freeze({ key: contract.key, version: contract.version, childPosition: contract.childPosition });
}

function synchronous(result) {
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Reception checks must be synchronous');
  }
}

// Isolated contract experiment, not a production Context/Relation replacement.
// FactCall still owns all relation transitions, pending events, commit uncertainty
// and exact receipts. This layer narrows only reception-value authentication.
export class ReceptionEvidenceCall {
  #call;
  #values;
  #contracts = new Map();
  #registrations = new WeakMap();
  #materials = new WeakMap();
  #pending = new Set();
  #mode = 'persistence';
  #checking = false;
  #establishmentFailed = false;
  #owner;
  stats = { establishmentCheck: 0, persistenceCheck: 0, restoredCheck: 0, receptionEncode: 0, persistenceDecode: 0, restoredDecode: 0, encodingBodyReads: 0, restoredBodyReads: 0, installed: 0, published: 0 };

  constructor(store, owner, input, { contracts = [], values = new StableValues(), restore = false } = {}) {
    this.#values = values;
    this.#owner = values.own(owner);
    for (const original of contracts) {
      const description = descriptor(original);
      const key = descriptorKey(description);
      assert.ok(!this.#contracts.has(key), 'Duplicate bound reception contract');
      assert.equal(typeof original.check, 'function');
      assert.equal(typeof original.codec?.encode, 'function');
      assert.equal(typeof original.codec?.decode, 'function');
      const binding = Object.freeze({ description, check: original.check.bind(original), encode: original.codec.encode.bind(original.codec), decode: original.codec.decode.bind(original.codec) });
      this.#contracts.set(key, binding);
      this.#registrations.set(original, binding);
    }
    const codec = Object.freeze({ key: format, encode: (value) => this.#encode(value), decode: (body) => this.#decode(body) });
    const codecs = new Map([[codec.key, codec]]);
    if (restore) {
      this.#mode = 'restored';
      const head = store.readHead(owner.contextId);
      assert.ok(head, 'Missing checkpoint');
      assert.deepEqual(head.identity, owner, 'Restored owner/contract changed');
      assert.equal(head.status, 'active', 'Terminal call cannot resume');
      const restored = store.restore(owner.contextId, codecs);
      assert.deepEqual(restored.head.identity, owner, 'Restored owner/contract changed');
      assert.equal(restored.head.status, 'active', 'Terminal call cannot resume');
      // Cold trust is rebuilt from persisted relations AND materials. A material
      // with valid shape cannot claim a different owner, child or reception.
      for (const relation of restored.relations.values()) {
        if (!['accepted', 'handled'].includes(relation.phase)) continue;
        const material = restored.values.get(relation.received);
        this.#checkMaterialRelation(material, relation, owner);
      }
      this.#call = new FactCall(store, owner, undefined, { values, codec, codecs, restored });
      this.#mode = 'persistence';
    } else this.#call = new FactCall(store, owner, input, { values, codec, codecs });
  }

  static reopen(store, owner, options) {
    return new ReceptionEvidenceCall(store, owner, undefined, { ...options, restore: true });
  }

  #active() {
    assert.ok(!this.#checking, 'Reception check cannot mutate the call');
    assert.ok(!this.#establishmentFailed, 'Reception establishment failed');
  }

  #check(binding, value, phase) {
    this.stats[`${phase}Check`]++;
    this.#checking = true;
    try {
      synchronous(binding.check(value));
    } catch (cause) {
      // Includes throw undefined. A failed assertion cannot become a successful
      // undefined value or be mistaken for absence of an error.
      throw new Error('Reception value violates its fixed contract', { cause });
    } finally {
      this.#checking = false;
    }
  }

  #binding(original) {
    const binding = this.#registrations.get(original);
    assert.ok(binding, 'Reception contract is not this exact registration');
    return binding;
  }

  #checkMaterialRelation(material, relation, owner) {
    assert.ok(material && this.#materials.has(material), 'Missing authenticated reception material');
    assert.equal(material.owner, owner.contextId, 'Reception material owner changed');
    assert.deepEqual(material.child, relation.identity, 'Reception material child changed');
    assert.equal(material.kind, relation.phase, 'Reception material phase changed');
    assert.equal(descriptorKey(material.contract), relation.reception, 'Reception material contract changed');
    assert.equal(material.contract.childPosition, relation.identity.position, 'Reception belongs to another child position');
  }

  #encode(value) {
    // Only an exact material installed by establish/decode gets special codec
    // treatment. An input/state with a similar object shape remains plain data.
    const binding = value && typeof value === 'object' && this.#materials.get(value);
    if (!binding) return this.#values.encode(this.#values.own({ type: 'plain', value }));
    this.stats.encodingBodyReads++;
    this.stats.receptionEncode++;
    const encoded = this.#values.own(binding.encode(value.value));
    return this.#values.encode(this.#values.own({ type: 'reception', owner: value.owner, child: value.child, kind: value.kind, contract: value.contract, encoded }));
  }

  #decode(body) {
    const saved = this.#values.decode(body);
    if (saved.type === 'plain') {
      assert.deepEqual(Object.keys(saved).sort(), ['type', 'value']);
      return saved.value;
    }
    assert.equal(saved.type, 'reception', 'Unknown reception wire type');
    assert.deepEqual(Object.keys(saved).sort(), ['child', 'contract', 'encoded', 'kind', 'owner', 'type']);
    assert.ok(['accepted', 'handled'].includes(saved.kind));
    const binding = this.#contracts.get(descriptorKey(descriptor(saved.contract)));
    assert.ok(binding, 'Incompatible reception contract');
    assert.deepEqual(saved.contract, binding.description, 'Reception descriptor changed');
    assert.equal(saved.owner, this.#owner.contextId, 'Reception material owner changed');
    assert.equal(saved.child?.parentId, this.#owner.contextId, 'Reception child parent changed');
    assert.equal(saved.child?.position, binding.description.childPosition, 'Reception belongs to another child position');
    this.stats[`${this.#mode}Decode`]++;
    if (this.#mode === 'restored') this.stats.restoredBodyReads++;
    const value = this.#values.own(binding.decode(saved.encoded));
    this.#check(binding, value, this.#mode);
    const material = this.#values.own({ owner: saved.owner, child: saved.child, kind: saved.kind, contract: binding.description, value });
    this.#materials.set(material, binding);
    return material;
  }

  createChild(id, input, options) {
    this.#active();
    return this.#call.createChild(id, input, options);
  }

  returned(child, value) {
    this.#active();
    return this.#call.returned(child, value);
  }

  failed(child, diagnostic, options) {
    this.#active();
    return this.#call.failed(child, diagnostic, options);
  }

  beginReception(child, contract) {
    this.#active();
    const binding = this.#binding(contract);
    assert.equal(child.position, binding.description.childPosition, 'Reception belongs to another child position');
    this.#call.beginReception(child, descriptorKey(binding.description));
  }

  establish(child, kind, candidate, contract) {
    this.#active();
    const binding = this.#binding(contract);
    const relation = this.#call.relation(child);
    assert.equal(kind, relation.result === 'succeeded' ? 'accepted' : 'handled', 'Reception does not match returned outcome');
    this.beginReception(child, contract);
    let fixed;
    try {
      try {
        fixed = this.#values.own(candidate);
      } catch (cause) {
        throw new Error('Reception value could not be fixed', { cause });
      }
      this.#check(binding, fixed, 'establishment');
    } catch (error) {
      this.#establishmentFailed = true;
      throw error;
    }
    const material = this.#values.own({ owner: this.#call.identity.contextId, child, kind, contract: binding.description, value: fixed });
    this.#materials.set(material, binding);
    this.#call.receive(child, material, descriptorKey(binding.description));
    this.#pending.add(material);
    this.stats.installed++;
    return fixed;
  }

  value(child) {
    const relation = this.#call.relation(child);
    assert.ok(['accepted', 'handled'].includes(relation.phase), 'Reception is not installed');
    const material = this.#call.value(relation.received);
    this.#checkMaterialRelation(material, relation, this.#call.identity);
    return material.value;
  }

  relation(child) {
    return this.#call.relation(child);
  }

  requireReception(child, contract, kind) {
    const binding = this.#binding(contract);
    const relation = this.#call.relation(child);
    assert.equal(relation.phase, kind, 'Reception has another outcome');
    assert.equal(relation.reception, descriptorKey(binding.description), 'Reception has another bound contract');
    assert.equal(child.position, binding.description.childPosition, 'Reception belongs to another child position');
  }

  get identity() {
    return this.#call.identity;
  }
  get input() {
    return this.#call.input;
  }
  get checkpointRevision() {
    return this.#call.checkpointRevision;
  }
  get checkpointHeadDigest() {
    return this.#call.checkpointHeadDigest;
  }
  factValue(id) {
    return this.#call.value(id);
  }
  material(id) {
    return this.#call.material(id);
  }
  allRelations() {
    return this.#call.allRelations();
  }
  relationIdentities() {
    return this.#call.relationIdentities();
  }
  relationCount(position, contract) {
    return this.#call.relationCount(position, contract);
  }
  latestRelation(position, contract) {
    return this.#call.latestRelation(position, contract);
  }
  referenceOf(slot) {
    return this.#call.referenceOf(slot);
  }
  referenceSize(slot) {
    return this.#call.referenceSize(slot);
  }
  referenceEntry(slot, id) {
    return this.#call.referenceEntry(slot, id);
  }
  referenceEntries(slot) {
    return this.#call.referenceEntries(slot);
  }
  referenceSlots() {
    return this.#call.referenceSlots();
  }
  changes() {
    return this.#call.changes();
  }
  reference(slot, child) {
    this.#active();
    return this.#call.reference(slot, child);
  }
  clearReference(slot) {
    this.#active();
    return this.#call.clearReference(slot);
  }
  addReference(slot, child, options) {
    this.#active();
    return this.#call.addReference(slot, child, options);
  }
  removeReference(slot, id) {
    this.#active();
    return this.#call.removeReference(slot, id);
  }
  capture(value) {
    this.#active();
    return this.#call.capture(value);
  }
  inspect(check) {
    this.#active();
    return this.#call.inspect(check);
  }

  save(point, state, options) {
    this.#active();
    const receipt = this.#call.save(point, state, options);
    // FactCall has already verified the exact commit receipt. No new loop over
    // history and no material body access is needed to advance this count.
    this.stats.published += this.#pending.size;
    this.#pending.clear();
    return receipt;
  }

  get factStats() {
    return this.#call.stats;
  }

  get encodings() {
    return new Map(this.#call.encodings);
  }
}
