import assert from 'node:assert/strict';
import { StableValues } from './stable.mjs';

// Isolated business-assertion experiment, NOT a cache of arbitrary point.check.
// The assertion below declares its exact dependencies by hand. No digest from
// an author, restored image, or another checker can install process evidence.
const statement = 'selected-model-input@1';

export class FixedModelEvidence {
  #call;
  #values;
  #certified = new Map();
  stats = { historicalChecks: 0, reused: 0, bodyReads: 0, currentChecks: 0, selectionScans: 0, installed: 0 };

  constructor(call, { values = new StableValues() } = {}) {
    this.#call = call;
    this.#values = values;
  }

  #read(id, material = false) {
    this.stats.bodyReads++;
    return material ? this.#call.material(id) : this.#call.value(id);
  }

  #prepare(point, state) {
    this.stats.currentChecks++;
    assert.equal(state.owner, this.#call.identity.contextId, 'Wrong selection owner');
    assert.equal(state.statement, statement, 'Unknown business statement');
    assert.equal(state.slot, 'models', 'Wrong selection slot');
    assert.ok(Number.isSafeInteger(state.position) && state.position >= 0, 'Invalid selection position');

    // Existing FactCall exposes enumeration, not an indexed occurrence endpoint.
    // Count this work honestly: this experiment proves evidence scope, not that
    // the complete author check is already incremental for unbounded selections.
    const entries = this.#call.referenceEntries(state.slot);
    this.stats.selectionScans += entries.length;
    const selected = entries[state.position];
    assert.ok(selected, 'Missing selected occurrence');
    assert.equal(selected.id, state.occurrence, 'Different selected occurrence');
    assert.deepEqual(selected.child, state.child, 'Different selected child');
    const relation = this.#call.relation(selected.child);
    assert.equal(relation.phase, 'accepted', 'Model is not accepted');
    assert.equal(relation.input, state.inputFact, 'Inaccurate input fact');
    assert.equal(state.current, relation.identity.contextId, 'Wrong current model');

    // Only bounded identities/positions enter the key. Raw content hashes do
    // not establish owner, relation, occurrence, or the meaning of a statement.
    const tuple = [this.#call.identity, statement, state.policyFact, state.policyVersion, relation.identity, relation.input, relation.output, relation.received, relation.reception, state.prefixFact, state.slot, state.occurrence, state.position];
    const key = JSON.stringify(tuple);
    let evidence = this.#certified.get(key);
    if (evidence) this.stats.reused++;
    else {
      this.stats.historicalChecks++;
      const policy = this.#read(state.policyFact, true);
      const prefix = this.#read(state.prefixFact, true);
      const input = this.#read(relation.input);
      const output = this.#read(relation.output);
      assert.equal(policy.statement, statement, 'Policy belongs to another statement');
      assert.equal(policy.version, state.policyVersion, 'Wrong policy version');
      assert.equal(prefix.owner, state.owner, 'Wrong prefix owner');
      assert.equal(prefix.count, state.position, 'Prefix has another selected position');
      assert.equal(input.position, state.position, 'Input has another selected position');
      assert.equal(input.prefixFact, state.prefixFact, 'Input selected another prefix');
      assert.equal(input.policyVersion, policy.version, 'Input selected another policy');
      assert.equal(input.key, policy.key, 'Input has another business key');
      assert.ok(Array.isArray(output.calls), 'Missing model calls');
      assert.ok(
        output.calls.every((call) => typeof call.id === 'string'),
        'Invalid model call',
      );
      assert.equal(new Set(output.calls.map((call) => call.id)).size, output.calls.length, 'Duplicate model call id');
      evidence = this.#values.own({ callCount: output.calls.length });
    }

    // B is a new composition on EVERY check, even when no facts were added and
    // A was certified. Its meaning is not inferred from the stable-value proof.
    assert.ok(Number.isSafeInteger(state.cursor) && state.cursor >= 0 && state.cursor <= evidence.callCount, 'Cursor exceeds current calls');
    assert.ok(['processing', 'waiting-tool', 'completed'].includes(point), 'Unknown current point');
    if (point === 'waiting-tool') assert.ok(state.cursor < evidence.callCount, 'No current tool to wait for');
    if (point === 'completed') assert.equal(state.cursor, evidence.callCount, 'Current model is not completed');
    return { key, evidence };
  }

  // Preparation alone deliberately has no acknowledgement/install operation.
  // It cannot be converted into evidence by presenting a forged Store receipt.
  check(point, state) {
    this.#prepare(point, this.#values.own(state));
  }

  save(point, state, { fault } = {}) {
    const fixed = this.#values.own(state);
    let prepared;
    // FactCall verifies the exact owner/revision/cursor/chain/head receipt. The
    // only install path follows its successful return; check/codec/commit/lost
    // receipt failures cannot publish a partial assertion certificate.
    const receipt = this.#call.save(point, fixed, {
      fault,
      check: (saved) => {
        prepared = this.#prepare(point, saved);
      },
    });
    if (!this.#certified.has(prepared.key)) {
      this.#certified.set(prepared.key, prepared.evidence);
      this.stats.installed++;
    }
    return receipt;
  }
}
