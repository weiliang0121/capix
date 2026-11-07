import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Deliberately restricted executable pseudocode, NOT a new runtime API.
// Only acyclic, plain, JSON data is admitted. No Proxy/hostile-object sandbox,
// arbitrary classes, live endpoints, production codecs or Frame authentication.
export class FixedData {
  #owned = new WeakSet();
  visits = 0;
  reused = 0;

  own(value, ancestors = new Set()) {
    if (value && typeof value === 'object' && this.#owned.has(value)) {
      this.reused++;
      return value;
    }
    this.visits++;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    assert.ok(value && typeof value === 'object', 'Expected plain data');
    assert.ok(!ancestors.has(value), 'Cyclic data is unsupported');
    const array = Array.isArray(value);
    assert.ok(array || Object.getPrototypeOf(value) === Object.prototype, 'Expected plain data');
    assert.equal(Object.getOwnPropertySymbols(value).length, 0, 'Symbols are unsupported');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => !array || key !== 'length');
    if (array)
      assert.deepEqual(
        keys,
        Array.from({ length: value.length }, (_, index) => String(index)),
        'Expected dense array',
      );
    const nextAncestors = new Set(ancestors).add(value);
    const result = array ? [] : {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'Accessors/non-enumerable data are unsupported');
      Object.defineProperty(result, key, { value: this.own(descriptor.value, nextAncestors), enumerable: true });
    }
    Object.freeze(result);
    this.#owned.add(result);
    return result;
  }
}

export const digest = (text) => createHash('sha256').update(text).digest('hex');

function checkRecord(record) {
  assert.deepEqual(Object.keys(record).sort(), ['id', 'kind', 'owner', 'value']);
  assert.ok(typeof record.id === 'string' && record.id.length);
  assert.ok(typeof record.owner === 'string' && record.owner.length);
  assert.ok(['input', 'returned', 'accepted', 'failure'].includes(record.kind));
  // These are the fixed business shapes of THIS small scenario.
  if (record.kind === 'input') assert.equal(typeof record.value.query, 'string');
  if (record.kind === 'returned') {
    assert.equal(typeof record.value.memoryId, 'string');
    assert.equal(typeof record.value.material.content, 'string');
  }
  if (record.kind === 'accepted') assert.equal(typeof record.value.text, 'string');
  if (record.kind === 'failure') assert.equal(typeof record.value.message, 'string');
}

export class Facts {
  fixed = new FixedData();
  #values = new Map();
  #pending = new Set();

  publish(id, kind, owner, value) {
    assert.ok(!this.#values.has(id), 'Fact identity cannot be reused');
    const record = Object.freeze({ id, kind, owner, value: this.fixed.own(value) });
    checkRecord(record);
    this.#values.set(id, record);
    this.#pending.add(record);
    return record.value;
  }

  get(id) {
    assert.ok(this.#values.has(id), 'Unknown fact');
    return this.#values.get(id);
  }

  pending() {
    return [...this.#pending];
  }

  acknowledge(records) {
    for (const record of records) this.#pending.delete(record);
  }
}

// A material store sketch, NOT CheckpointStore or a durability implementation.
// It exposes remaining full-ref/state work rather than claiming O(1) saves.
export class StudyJournal {
  #rows = new Map();
  #head;
  #encodings = new Map();
  #fixed = new FixedData();

  save(facts, point, state, refs, encode = (value) => value) {
    const pending = facts.pending();
    const staged = new Map();
    for (const record of pending) {
      this.#encodings.set(record.id, (this.#encodings.get(record.id) ?? 0) + 1);
      // Encoding is deliberately delayed until first persistence, AFTER value
      // ownership is established. Codec failure cannot rewrite a fact.
      const encoded = this.#fixed.own({ ...record, value: encode(record.value) });
      checkRecord(encoded);
      const body = JSON.stringify({ codec: 'study.plain@1', record: encoded });
      staged.set(record.id, Object.freeze({ id: record.id, body, digest: digest(body) }));
    }
    for (const ref of refs) assert.ok(staged.has(ref) || this.#rows.has(ref), 'Missing fact body');
    const head = this.#fixed.own({ format: 'fact-study@1', revision: (this.#head?.revision ?? 0) + 1, point, state, refs });
    for (const [id, row] of staged) this.#rows.set(id, row);
    this.#head = head;
    facts.acknowledge(pending);
    return { head, encoded: pending.map((record) => record.id), refsChecked: refs.length, headBytes: Buffer.byteLength(JSON.stringify(head)) };
  }

  counts() {
    return Object.fromEntries(this.#encodings);
  }

  bundle() {
    // Full export for the cross-process experiment, not the incremental save.
    return { head: this.#head, rows: [...this.#rows.values()] };
  }
}

export function restoreBundle(bundle) {
  const fixed = new FixedData(); // Fresh process/fresh trust domain.
  const head = fixed.own(bundle.head);
  assert.equal(head.format, 'fact-study@1');
  assert.ok(Number.isSafeInteger(head.revision) && head.revision > 0);
  assert.ok(typeof head.point === 'string' && head.point.length);
  assert.ok(Array.isArray(head.refs));
  const records = new Map();
  for (const row of bundle.rows) {
    assert.equal(digest(row.body), row.digest, 'Corrupt fact body');
    const saved = fixed.own(JSON.parse(row.body));
    assert.equal(saved.codec, 'study.plain@1', 'Incompatible codec');
    checkRecord(saved.record);
    assert.equal(saved.record.id, row.id, 'Fact identity mismatch');
    assert.ok(!records.has(row.id), 'Duplicate fact identity');
    records.set(row.id, saved.record);
  }
  for (const ref of head.refs) assert.ok(records.has(ref), 'Missing fact body');
  return { head, records, validatedValues: fixed.visits };
}
