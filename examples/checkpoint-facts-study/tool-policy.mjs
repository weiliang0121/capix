import assert from 'node:assert/strict';
import { isDeepStrictEqual as equal } from 'node:util';
import { requireExchangeIntakeReceipt, requireExchangeFeedbackReceipt } from '@weiliang0121/capix-model-exchanges';
import { StableValues } from './stable.mjs';
import { ToolRelations } from './tool-relations.mjs';

const contractKey = (contract) => JSON.stringify([contract.key, contract.version]);
const idOf = (ref) => ref.contextId;

// A policy projection over already-authenticated facts, NOT an Invocation,
// checkpoint writer, or public API proposal. Explicit mutation operations make
// invalidation visible. The fixture adapter below computes those operations
// from full snapshots; its scan is counted separately and is not a hot-path
// implementation. A real binding must consume the fact/selection delta ledger.
export class ToolPolicyProbe {
  #fixture;
  #values = new StableValues();
  #records = new Map();
  #index = new ToolRelations();
  #slots = new Map();
  #ranks = new Map();
  #modelPositions = new Map();
  #exchanges = [];
  #input;
  #state;
  #point;
  #parent;
  #revision = 0;
  #full = true;
  #dirty = new Set();
  #certifiedModels = 0;
  #prepared = new WeakMap();
  #uncertain = false;
  stats = { checks: 0, fullChecks: 0, modelAssertions: 0, historicalModelAssertions: 0, modelPrefixItems: 0, currentQueries: 0, candidateInputs: 0, selectionRebuildItems: 0, projectionUpdates: 0, fixtureComparisons: 0 };

  constructor(fixture) {
    this.#fixture = fixture;
  }

  #mutable() {
    assert.equal(this.#uncertain, false, 'Reopen after an uncertain checkpoint receipt');
    this.#revision++;
    this.stats.projectionUpdates++;
  }

  configure(input, parentId) {
    this.#mutable();
    this.#input = this.#values.own(input);
    this.#parent = parentId;
    // An input/configuration replacement cannot reuse policy certificates.
    this.#full = true;
  }

  put(record) {
    this.#mutable();
    const fixed = this.#values.own(record);
    this.#index.put({ ...fixed, identity: { ...fixed.identity, position: String(fixed.identity.position), contract: contractKey(fixed.identity.contract) } });
    this.#records.set(fixed.identity.contextId, fixed);
    for (const position of this.#modelPositions.get(fixed.identity.contextId) ?? []) this.#dirty.add(position);
  }

  appendReference(slot, reference) {
    this.#mutable();
    assert.ok(this.#records.has(idOf(reference)), 'Unknown selected child');
    const refs = this.#slots.get(slot) ?? [];
    const ranks = this.#ranks.get(slot) ?? new Map();
    const rank = refs.length;
    refs.push(this.#values.own(reference));
    if (!ranks.has(idOf(reference))) ranks.set(idOf(reference), rank);
    this.#slots.set(slot, refs);
    this.#ranks.set(slot, ranks);
    if (slot === 'models') {
      const positions = this.#modelPositions.get(idOf(reference)) ?? [];
      positions.push(rank);
      this.#modelPositions.set(idOf(reference), positions);
      this.#dirty.add(rank);
    }
  }

  replaceReferences(slot, references) {
    this.#mutable();
    if (slot === 'models') {
      this.#modelPositions.clear();
      this.#full = true;
    }
    this.#slots.set(slot, []);
    this.#ranks.set(slot, new Map());
    for (const ref of references) {
      this.stats.selectionRebuildItems++;
      this.appendReference(slot, ref);
    }
  }

  appendExchange(reference) {
    this.#mutable();
    // The previous current model now also needs a receipt-to-closed-ref check.
    this.#dirty.add(this.#exchanges.length);
    this.#exchanges.push(this.#values.own(reference));
  }

  replaceExchanges(references) {
    this.#mutable();
    this.#exchanges = references.map((ref) => this.#values.own(ref));
    this.#full = true;
  }

  setState(point, { current, cursor, active }) {
    this.#mutable();
    assert.ok(this.#fixture.points.has(point), 'Unknown point');
    this.#state = this.#values.own({ current, cursor, active });
    this.#point = point;
  }

  #record(reference, position) {
    const record = this.#records.get(idOf(reference));
    assert.ok(record, 'Missing child');
    assert.equal(record.identity.parentId, this.#parent, 'Foreign child');
    if (position !== undefined) assert.equal(record.identity.position, position, 'Wrong member');
    return record;
  }

  #receipt(record, status, model = false) {
    assert.equal(record.reception.status, status, 'Missing reception under expected contract');
    assert.equal(record.identity.position, model ? 0 : 1, 'Wrong reception member');
    return model ? requireExchangeIntakeReceipt(record.reception.value) : requireExchangeFeedbackReceipt(record.reception.value);
  }

  #model(index) {
    const model = this.#record(this.#slots.get('models')[index], 0);
    this.stats.modelAssertions++;
    if (index < this.#certifiedModels - 1) this.stats.historicalModelAssertions++;
    this.stats.modelPrefixItems += index;
    assert.deepEqual(model.input, { exchanges: this.#exchanges.slice(0, index) }, 'Model input differs from fixed prefix');
    const expected = this.#exchanges[index];
    if (expected) {
      const receipt = this.#receipt(model, 'accepted', true);
      assert.equal(receipt.reference.collection, expected.collection, 'Wrong model receipt collection');
      assert.equal(receipt.reference.id, expected.id, 'Wrong model receipt exchange');
    }
  }

  #selectedTool(model, call, selected) {
    const definition = selected.entry.registration.node;
    const position = this.#fixture.loop.members.indexOf(definition);
    const candidates = this.#index.query({ parentId: this.#parent, position: String(position), contract: contractKey(definition.checkpoint), key: call.id, after: model.order });
    // Unlike cold confirmation, production check has NO next-model upper bound.
    // The author rank index preserves .find order and duplicate occurrences.
    const ranks = this.#ranks.get(selected.entry.name);
    let best;
    let rank = Infinity;
    for (const candidate of candidates) {
      const nextRank = ranks?.get(candidate.identity.contextId);
      if (nextRank === undefined || nextRank >= rank) continue;
      this.stats.candidateInputs++;
      if (!equal(candidate.input, selected.input)) continue;
      best = this.#records.get(candidate.identity.contextId);
      rank = nextRank;
    }
    return best;
  }

  prepare({ restored = false } = {}) {
    assert.equal(this.#uncertain, false, 'Reopen after an uncertain checkpoint receipt');
    this.stats.checks++;
    const loop = this.#fixture.loop;
    assert.equal(this.#input.catalog, loop.catalog.digest, 'Catalog changed');
    assert.equal(this.#input.maxModelCalls, loop.maxModelCalls, 'Model budget changed');
    assert.equal(this.#input.waitMs, loop.waitMs, 'Wait budget changed');
    assert.deepEqual(this.#input.budgets, loop.budgets, 'Budgets changed');
    const models = this.#slots.get('models');
    let selected = 0;
    for (const refs of this.#slots.values()) selected += refs.length;
    assert.ok(models, 'Missing models slot');
    assert.equal(this.#records.size, selected, 'Omitted child relations');
    assert.equal(models.length, this.#exchanges.length + 1, 'Model prefix changed');
    assert.ok(models.length <= loop.maxModelCalls, 'Model count exceeded');
    if (restored || this.#full) {
      this.stats.fullChecks++;
      for (let index = 0; index < models.length; index++) this.#model(index);
    } else for (const index of this.#dirty) if (index < models.length) this.#model(index);

    const state = this.#state;
    if (!state.current) assert.ok(!state.active && state.cursor === 0, 'Waiting model has progress');
    else {
      // B always reads the current combination, including when delta is empty.
      this.stats.currentQueries++;
      const model = this.#record(models.at(-1), 0);
      const receipt = this.#receipt(model, 'accepted', true);
      assert.equal(receipt.reference.collection, state.current.collection, 'Wrong current collection');
      assert.equal(receipt.reference.id, state.current.id, 'Wrong current exchange');
      assert.equal(model.returned?.status, 'succeeded', 'Current model did not succeed');
      const calls = model.returned.output.output.filter((item) => item.kind === 'tool-call');
      assert.ok(state.cursor <= calls.length, 'Tool cursor exceeds requests');
      for (let index = 0; index < state.cursor; index++) {
        const call = calls[index];
        const selected = loop.checkToolCall(call);
        if (selected.kind === 'rejected') continue;
        const child = this.#selectedTool(model, call, selected);
        assert.ok(child, 'Processed tool lacks exact child');
        const receipt = this.#receipt(child, child.reception.status === 'accepted' ? 'accepted' : 'handled');
        assert.equal(receipt.reference.collection, state.current.collection, 'Tool receipt collection differs');
        assert.equal(receipt.reference.id, state.current.id, 'Tool receipt exchange differs');
      }
      if (state.active) {
        const call = calls[state.cursor];
        const selected = call && loop.checkToolCall(call);
        const ref = this.#slots.get(state.active.name)?.[state.active.index];
        const child = ref && this.#record(ref);
        assert.ok(call && selected?.kind === 'accepted' && selected.entry.name === state.active.name && call.id === state.active.callId && child && child.order > model.order && child.key === call.id && equal(child.input, selected.input), 'Active tool differs from fixed request');
      }
    }
    const token = Object.freeze({});
    this.#prepared.set(token, { revision: this.#revision, models: models.length });
    return token;
  }

  acknowledge(token) {
    assert.equal(this.#uncertain, false, 'Reopen after an uncertain checkpoint receipt');
    const result = this.#prepared.get(token);
    assert.ok(result && result.revision === this.#revision, 'Validation no longer matches acknowledged head');
    this.#prepared.delete(token);
    this.#certifiedModels = result.models;
    this.#dirty.clear();
    this.#full = false;
  }

  uncertain() {
    this.#uncertain = true;
  }

  snapshot() {
    return structuredClone({ point: this.#point, parentId: this.#parent, input: this.#input, state: { ...this.#state, exchanges: this.#exchanges }, refs: Object.fromEntries(this.#slots), records: [...this.#records.values()] });
  }

  get indexStats() {
    return { ...this.#index.stats };
  }

  // Test-only translation of complete oracle snapshots into explicit commands.
  // This necessarily scans snapshots: NEVER count it as an incremental writer.
  feed(snapshot) {
    if (!equal(this.#input, snapshot.input) || this.#parent !== snapshot.parentId) this.configure(snapshot.input, snapshot.parentId);
    for (const record of snapshot.records) {
      this.stats.fixtureComparisons++;
      if (!equal(this.#records.get(record.identity.contextId), record)) this.put(record);
    }
    assert.equal(this.#records.size, snapshot.records.length, 'Fixture does not remove actual relations');
    for (const [slot, next] of Object.entries(snapshot.refs)) {
      const prior = this.#slots.get(slot) ?? [];
      this.stats.fixtureComparisons += prior.length;
      if (next.length >= prior.length && prior.every((ref, index) => equal(ref, next[index]))) for (let index = prior.length; index < next.length; index++) this.appendReference(slot, next[index]);
      else this.replaceReferences(slot, next);
    }
    for (const slot of this.#slots.keys()) if (!(slot in snapshot.refs)) this.replaceReferences(slot, []);
    const next = snapshot.state.exchanges;
    this.stats.fixtureComparisons += this.#exchanges.length;
    if (next.length >= this.#exchanges.length && this.#exchanges.every((ref, index) => equal(ref, next[index]))) for (let index = this.#exchanges.length; index < next.length; index++) this.appendExchange(next[index]);
    else this.replaceExchanges(next);
    this.setState(snapshot.point, snapshot.state);
  }
}
