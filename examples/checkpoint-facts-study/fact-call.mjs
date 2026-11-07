import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StableValues } from './stable.mjs';
import { checkRelation, hash, identity, stableCodec, ReferenceList } from './fact-store.mjs';

export function runPointCheck(check, state, facts) {
  const result = check(state, facts);
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new Error('Checkpoint check must be synchronous');
  }
}

// Executable protocol model, not an Invocation implementation. The real Runner
// lifecycle remains covered separately by receipt-recovery/migration tests.
export class FactCall {
  #store;
  #values;
  #codecs;
  #codec;
  #facts = new Map();
  #pending = [];
  #relations = new Map();
  #refs = new Map();
  #refKinds = new Map();
  #manyRefs = new Map();
  #relationGroups = new Map();
  #restored = false;
  #revision = 0;
  #cursor = 0;
  #chain = hash('fact-head-study@1');
  #headDigest;
  #uncertain = false;
  #saving = false;
  #terminal = false;
  #order = 0;
  #input;
  identity;
  stats = { encodedFacts: 0, factReads: 0, checks: 0, authoredScans: 0, relationMetadataVisits: 0, referenceUpdates: 0, relationUpdates: 0, stateEncodes: 0, relationReads: 0, referenceScans: 0, deltaReads: 0 };
  encodings = new Map();

  constructor(store, owner, input, { values = new StableValues(), codec = stableCodec(values), codecs = new Map([[codec.key, codec]]), restored } = {}) {
    this.#store = store;
    this.#values = values;
    this.#codec = codec;
    this.#codecs = codecs;
    this.identity = Object.freeze({ ...owner });
    if (restored) {
      assert.deepEqual(restored.head.identity, owner);
      this.#revision = restored.head.revision;
      this.#cursor = restored.head.cursor;
      this.#chain = restored.head.chain;
      this.#headDigest = hash(JSON.stringify(restored.head));
      this.#order = restored.head.childCount;
      this.#input = restored.head.input;
      this.#terminal = restored.head.status !== 'active';
      this.#relations = new Map([...restored.relations].map(([id, relation]) => [id, values.own(relation)]));
      this.#refs = new Map([...restored.refs].map(([slot, reference]) => [slot, values.own(reference)]));
      this.#refKinds = new Map(restored.refKinds);
      this.#manyRefs = new Map(
        [...restored.manyRefs].map(([slot, list]) => {
          const fixed = new ReferenceList();
          for (const entry of list.entries()) fixed.add(entry.id, values.own(entry.child));
          return [slot, fixed];
        }),
      );
      for (const relation of this.#relations.values()) this.#indexRelation(relation, true);
      this.#restored = true;
      for (const [id, value] of restored.values) this.#facts.set(id, { value: values.own(value), meta: values.own(restored.metadata.get(id)), published: true });
    } else this.#input = this.#fact(`${owner.contextId}:input`, 'input', owner.contextId, input);
  }

  static reopen(store, id, options = {}) {
    const values = options.values ?? new StableValues();
    const codec = options.codec ?? stableCodec(values);
    const codecs = options.codecs ?? new Map([[codec.key, codec]]);
    const restored = store.restore(id, codecs);
    return new FactCall(store, restored.head.identity, undefined, { values, codec, codecs, restored });
  }

  #active() {
    assert.ok(!this.#saving, 'Reentrant mutation during checkpoint');
    assert.ok(!this.#uncertain, 'Commit uncertain; reopen from durable state');
    assert.ok(!this.#terminal, 'Terminal call cannot resume');
  }

  #fact(id, kind, owner, value) {
    assert.ok(!this.#facts.has(id), 'Fact identity reused');
    const fixed = this.#values.own(value);
    this.#facts.set(id, { value: fixed, meta: { id, owner, kind, codec: this.#codec.key }, published: false });
    this.#pending.push({ type: 'publish', id });
    return id;
  }

  #update(next) {
    const previous = this.#relations.get(next.identity.contextId);
    checkRelation(previous, next);
    const fixed = this.#values.own(next);
    this.#relations.set(next.identity.contextId, fixed);
    this.#indexRelation(fixed, !previous);
    this.#pending.push({ type: 'relation', value: fixed });
    this.stats.relationUpdates++;
    return fixed;
  }

  createChild(id, input, { position = 'child', contract = 'study@1', key } = {}) {
    this.#active();
    assert.ok(!this.#relations.has(id), 'Duplicate child');
    assert.ok(key === undefined || typeof key === 'string', 'Invalid relation key');
    const child = identity(id, this.identity.contextId, position, this.#order + 1, contract);
    const inputId = this.#fact(`${id}:input`, 'input', id, input);
    this.#update({ identity: child, ...(key === undefined ? {} : { key }), input: inputId, phase: 'waiting', result: null, output: null, received: null, reception: null, allowed: false });
    this.#order++;
    return child;
  }

  returned(child, value) {
    this.#active();
    const previous = this.#getRelation(child);
    assert.equal(previous.phase, 'waiting');
    const output = this.#fact(`${child.contextId}:returned`, 'returned', child.contextId, value);
    return this.#update({ ...previous, phase: 'returned', result: 'succeeded', output, allowed: true });
  }

  failed(child, diagnostic, { receptionAllowed = true } = {}) {
    this.#active();
    const previous = this.#getRelation(child);
    assert.equal(previous.phase, 'waiting');
    const output = this.#fact(`${child.contextId}:failure`, 'failure', child.contextId, diagnostic);
    return this.#update({ ...previous, phase: 'returned', result: 'failed', output, allowed: receptionAllowed });
  }

  beginReception(child, contract = 'reception@1') {
    this.#active();
    const previous = this.#getRelation(child);
    if (previous.phase === 'receiving') {
      assert.equal(previous.reception, contract, 'Reception contract changed');
      return;
    }
    this.#update({ ...previous, phase: 'receiving', reception: contract });
  }

  receive(child, value, contract = 'reception@1') {
    this.beginReception(child, contract);
    const previous = this.#getRelation(child);
    const phase = previous.result === 'succeeded' ? 'accepted' : 'handled';
    const received = this.#fact(`${this.identity.contextId}:${child.contextId}:${phase}`, phase, this.identity.contextId, value);
    this.#update({ ...previous, phase, received });
    return this.value(received);
  }

  // Slot choices preserve author order and occurrences. Removing a choice never
  // removes the relation, delivery, or reception that made it meaningful.
  #slot(slot, kind) {
    assert.ok(typeof slot === 'string' && slot.length > 0);
    const existing = this.#refKinds.get(slot);
    assert.ok(existing === undefined || existing === kind, 'Reference cardinality changed');
  }

  reference(slot, child) {
    this.#active();
    this.#getRelation(child);
    this.#slot(slot, 'single');
    const fixed = this.#values.own(child);
    this.#refKinds.set(slot, 'single');
    this.#refs.set(slot, fixed);
    this.#pending.push({ type: 'ref', slot, value: fixed });
    this.stats.referenceUpdates++;
  }

  clearReference(slot) {
    this.#active();
    this.#slot(slot, 'single');
    if (!this.#refs.delete(slot)) return false;
    this.#pending.push({ type: 'ref-clear', slot });
    this.stats.referenceUpdates++;
    return true;
  }

  addReference(slot, child, { before = null } = {}) {
    this.#active();
    this.#getRelation(child);
    this.#slot(slot, 'many');
    const fixed = this.#values.own(child);
    const list = this.#manyRefs.get(slot) ?? new ReferenceList();
    const id = randomUUID();
    list.add(id, fixed, before);
    this.#refKinds.set(slot, 'many');
    this.#manyRefs.set(slot, list);
    this.#pending.push({ type: 'ref-add', slot, id, value: fixed, before });
    this.stats.referenceUpdates++;
    return id;
  }

  removeReference(slot, id) {
    this.#active();
    this.#slot(slot, 'many');
    assert.ok(typeof id === 'string' && id.length > 0, 'Invalid reference occurrence');
    if (!this.#manyRefs.get(slot)?.remove(id)) return false;
    this.#pending.push({ type: 'ref-remove', slot, id });
    this.stats.referenceUpdates++;
    return true;
  }

  referenceOf(slot) {
    this.#slot(slot, 'single');
    return this.#refs.get(slot);
  }

  referenceSize(slot) {
    this.#slot(slot, 'many');
    return this.#manyRefs.get(slot)?.size ?? 0;
  }

  hasReference(slot, child) {
    this.#slot(slot, 'many');
    this.#getRelation(child);
    return this.#manyRefs.get(slot)?.has(child.contextId) ?? false;
  }

  referenceEntries(slot) {
    this.#slot(slot, 'many');
    const list = this.#manyRefs.get(slot);
    this.stats.referenceScans += list?.size ?? 0;
    return Object.freeze((list?.entries() ?? []).map((entry) => Object.freeze(entry)));
  }

  referenceEntry(slot, id) {
    this.#slot(slot, 'many');
    return this.#manyRefs.get(slot)?.entry(id);
  }

  referenceSlots() {
    return Object.freeze([...this.#refKinds].map(([slot, kind]) => Object.freeze({ slot, kind })));
  }

  references(slot) {
    return Object.freeze(this.referenceEntries(slot).map((entry) => entry.child));
  }

  #indexRelation(relation, added) {
    const key = JSON.stringify([relation.identity.position, relation.identity.contract]);
    const group = this.#relationGroups.get(key) ?? { count: 0, latest: null };
    if (added) group.count++;
    if (!group.latest || relation.identity.order >= group.latest.identity.order) group.latest = relation;
    this.#relationGroups.set(key, group);
  }

  relationCount(position, contract) {
    this.stats.relationReads++;
    if (position === undefined && contract === undefined) return this.#relations.size;
    return this.#relationGroups.get(JSON.stringify([position, contract]))?.count ?? 0;
  }

  latestRelation(position, contract) {
    this.stats.relationReads++;
    return this.#relationGroups.get(JSON.stringify([position, contract]))?.latest;
  }

  capture(value) {
    this.#active();
    return this.#fact(`${this.identity.contextId}:material:${randomUUID()}`, 'material', this.identity.contextId, value);
  }

  material(id) {
    const fact = this.#facts.get(id);
    assert.ok(fact, 'Missing local material');
    assert.equal(fact.meta.owner, this.identity.contextId, 'Foreign material owner');
    assert.equal(fact.meta.kind, 'material', 'Reference is not local material');
    return this.value(id);
  }

  changes() {
    this.stats.deltaReads += this.#pending.length;
    return this.#values.own({ mode: this.#restored ? 'restored' : 'live', baseRevision: this.#revision, events: this.#pending.map((event) => (event.type === 'publish' ? { type: 'fact', id: event.id, kind: this.#facts.get(event.id).meta.kind } : event)) });
  }

  #getRelation(child) {
    const relation = this.#relations.get(child.contextId);
    assert.ok(relation, 'Unknown child');
    assert.deepEqual(relation.identity, child, 'Inaccurate child identity');
    return relation;
  }

  relation(child) {
    this.stats.relationReads++;
    return this.#getRelation(child);
  }

  value(id) {
    const fact = this.#facts.get(id);
    assert.ok(fact, 'Unknown fact');
    this.stats.factReads++;
    return fact.value;
  }

  allRelations() {
    this.stats.authoredScans += this.#relations.size;
    return [...this.#relations.values()];
  }

  *relationIdentities() {
    for (const relation of this.#relations.values()) {
      this.stats.relationMetadataVisits++;
      yield relation.identity;
    }
  }

  get input() {
    return this.value(this.#input);
  }

  inspect(check) {
    this.#active();
    this.#saving = true;
    try {
      return check();
    } finally {
      this.#saving = false;
    }
  }

  get checkpointRevision() {
    return this.#revision;
  }
  get checkpointHeadDigest() {
    return this.#headDigest;
  }

  save(point, state, { check = () => {}, fault, status = 'active', delivery = null } = {}) {
    this.#active();
    this.#saving = true;
    try {
      return this.#save(point, state, { check, fault, status, delivery });
    } finally {
      this.#saving = false;
    }
  }

  #save(point, state, { check, fault, status, delivery }) {
    const fixed = this.#values.own(state);
    this.stats.checks++;
    runPointCheck(check, fixed, Object.freeze({ input: () => this.input, value: (id) => this.value(id), material: (id) => this.material(id), relation: (child) => this.relation(child), allRelations: () => this.allRelations(), changes: () => this.changes(), referenceOf: (slot) => this.referenceOf(slot), references: (slot) => this.references(slot), referenceEntries: (slot) => this.referenceEntries(slot), referenceSize: (slot) => this.referenceSize(slot), hasReference: (slot, child) => this.hasReference(slot, child), relationCount: (position, contract) => this.relationCount(position, contract), latestRelation: (position, contract) => this.latestRelation(position, contract) })); // Author checks still run each save and may read history.
    this.stats.stateEncodes++;
    const encodedState = this.#codec.encode(fixed);
    const facts = [];
    const events = [];
    const published = [];
    for (const event of this.#pending) {
      if (event.type !== 'publish') {
        events.push(event);
        continue;
      }
      const fact = this.#facts.get(event.id);
      let meta = fact.meta;
      if (!fact.published) {
        this.stats.encodedFacts++;
        this.encodings.set(event.id, (this.encodings.get(event.id) ?? 0) + 1);
        const body = this.#codec.encode(fact.value);
        // Explicit experiment rule: new durable representations must preserve
        // stable value semantics. No old codec/check is invoked on later saves.
        assert.deepEqual(this.#codec.decode(body), fact.value, 'Codec changed fact semantics');
        meta = { ...meta, digest: hash(body) };
        const existing = this.#store.factMeta(meta.id);
        if (existing) assert.deepEqual({ ...existing }, meta, 'Conflicting fixed fact');
        else facts.push({ ...meta, body });
        events.push({ type: existing ? 'link' : 'fact', value: meta });
      } else events.push({ type: 'link', value: meta });
      published.push([fact, meta]);
    }
    // A throw from encoding is before persistence. Once commit is entered,
    // neither thrown errors nor invalid receipts prove that nothing committed.
    this.#uncertain = true;
    const expectedCursor = this.#cursor + events.length;
    let expectedChain = this.#chain;
    for (const [index, event] of events.entries()) expectedChain = hash(JSON.stringify([expectedChain, this.#cursor + index + 1, JSON.stringify(event)]));
    const expectedHead = { format: 'fact-head-study@1', identity: this.identity, revision: this.#revision + 1, input: this.#input, point, state: encodedState, stateCodec: this.#codec.key, status, delivery, cursor: expectedCursor, chain: expectedChain, childCount: this.#order };
    const receipt = this.#store.commit({ identity: this.identity, expected: this.#revision, input: this.#input, state: encodedState, stateCodec: this.#codec.key, point, status, delivery, events, facts }, fault);
    assert.equal(receipt.owner, this.identity.contextId, 'Invalid receipt owner');
    assert.equal(receipt.revision, this.#revision + 1, 'Invalid receipt revision');
    assert.equal(receipt.cursor, expectedCursor, 'Invalid receipt cursor');
    assert.equal(receipt.chain, expectedChain, 'Invalid receipt chain');
    assert.equal(receipt.headDigest, hash(JSON.stringify(expectedHead)), 'Invalid receipt head');
    for (const [fact, meta] of published) {
      fact.meta = meta;
      fact.published = true;
    }
    this.#pending = [];
    this.#restored = false;
    this.#revision = receipt.revision;
    this.#headDigest = receipt.headDigest;
    this.#cursor = receipt.cursor;
    this.#chain = receipt.chain;
    this.#terminal = status !== 'active';
    this.#uncertain = false;
    return receipt;
  }

  finish(value, options = {}) {
    this.#active();
    assert.ok(this.#revision > 0, 'No first checkpoint; no implicit child finish');
    const delivery = this.#fact(`${this.identity.contextId}:returned`, 'returned', this.identity.contextId, value);
    return this.save('finished', null, { ...options, status: 'succeeded', delivery });
  }

  fail(options = {}) {
    return this.save('finished', null, { ...options, status: 'failed' });
  }

  // Waiting follows later child progress. Already delivered facts never chase
  // the current child head. This method does not execute or resend anything.
  resolve(child) {
    this.#active();
    const relation = this.#getRelation(child);
    if (relation.phase !== 'waiting') return { mode: relation.phase, relation };
    const restored = this.#store.restore(child.contextId, this.#codecs);
    assert.deepEqual(restored.head.identity, child, 'Child identity/contract mismatch');
    const original = this.#facts.get(relation.input).meta;
    assert.deepEqual(restored.metadata.get(restored.head.input), original, 'Child input mismatch');
    assert.notEqual(restored.head.status, 'failed', 'Failed child cannot resume');
    if (restored.head.status === 'active') return { mode: 'continuation', point: restored.head.point, state: this.#values.own(restored.state) };
    const id = restored.head.delivery;
    this.#facts.set(id, { value: this.#values.own(restored.values.get(id)), meta: restored.metadata.get(id), published: true });
    this.#pending.push({ type: 'publish', id });
    this.#update({ ...relation, phase: 'returned', result: 'succeeded', output: id, allowed: true });
    return { mode: 'returned', value: this.value(id) };
  }
}
