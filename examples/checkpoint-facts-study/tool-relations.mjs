import assert from 'node:assert/strict';

// Derived lookup only: relation identity, phase transitions and stable input
// bodies still belong to the authenticated fact ledger. A tool key is not an ID.
export class ToolRelations {
  #relations = new Map();
  #buckets = new Map();
  stats = { inserted: 0, updated: 0, queries: 0, queryComparisons: 0, queryCandidates: 0, reads: 0, referenceScans: 0, referenceCandidates: 0 };

  constructor(records = []) {
    // Cold rebuild groups once, then sorts. It does not repeatedly insert a
    // restored, potentially unordered history into the middle of an array.
    for (const record of records) this.#put(record, true);
    for (const bucket of this.#buckets.values()) bucket.sort((left, right) => left.order - right.order);
  }

  get size() {
    return this.#relations.size;
  }

  get(contextId) {
    this.stats.reads++;
    return this.#relations.get(contextId);
  }

  put(record) {
    return this.#put(record, false);
  }

  #put(record, rebuilding) {
    const identity = record.identity;
    for (const name of ['contextId', 'parentId', 'position', 'contract']) assert.ok(typeof identity?.[name] === 'string' && identity[name].length > 0, `Missing relation ${name}`);
    assert.ok(Number.isSafeInteger(identity.order) && identity.order >= 0, 'Invalid relation order');
    assert.ok(record.key === undefined || typeof record.key === 'string', 'Invalid relation key');
    const previous = this.#relations.get(identity.contextId);
    if (previous) {
      assert.deepEqual(identity, previous.identity, 'Relation identity changed');
      assert.equal(record.key, previous.key, 'Relation key changed');
    }
    // Own the index coordinates even when the caller gives a mutable wrapper.
    // Input is deliberately not read, copied or used as an index coordinate.
    const fixed = Object.freeze({ ...record, identity: Object.freeze({ ...identity }) });
    if (previous) {
      this.#relations.set(identity.contextId, fixed);
      this.stats.updated++;
      return fixed;
    }
    const key = bucketKey(identity, record.key);
    const bucket = this.#buckets.get(key) ?? [];
    const entry = Object.freeze({ contextId: identity.contextId, order: identity.order });
    if (rebuilding || bucket.length === 0 || bucket.at(-1).order <= entry.order) bucket.push(entry);
    else bucket.splice(boundary(bucket, entry.order, true), 0, entry);
    this.#buckets.set(key, bucket);
    this.#relations.set(identity.contextId, fixed);
    this.stats.inserted++;
    return fixed;
  }

  // The interval is exclusive at both ends, matching two consecutive model
  // calls. All candidates survive; accurate input and author selection are
  // separate predicates. Query work is O(log(bucket size) + matches).
  query({ parentId, position, contract, key, after = -Infinity, before = Infinity }) {
    for (const value of [parentId, position, contract]) assert.ok(typeof value === 'string' && value.length > 0, 'Incomplete relation scope');
    assert.ok(key === undefined || typeof key === 'string', 'Invalid query key');
    assert.ok(after === -Infinity || Number.isSafeInteger(after), 'Invalid lower bound');
    assert.ok(before === Infinity || Number.isSafeInteger(before), 'Invalid upper bound');
    assert.ok(after < before, 'Empty or reversed model interval');
    this.stats.queries++;
    const bucket = this.#buckets.get(bucketKey({ parentId, position, contract }, key));
    if (!bucket) return Object.freeze([]);
    const compare = () => this.stats.queryComparisons++;
    const start = boundary(bucket, after, true, compare);
    const end = boundary(bucket, before, false, compare);
    const selected = [];
    for (let index = start; index < end; index++) {
      selected.push(this.#relations.get(bucket[index].contextId));
      this.stats.queryCandidates++;
    }
    return Object.freeze(selected);
  }

  // Production .find follows author refs order, which need not be creation
  // order. This compatibility helper retains that order and occurrences. Its
  // O(refs) scan is explicit; the candidate index alone does not eliminate it.
  firstInReferences(candidates, references, predicate = () => true) {
    const selected = new Map();
    for (const candidate of candidates) selected.set(candidate.identity.contextId, candidate);
    for (const reference of references) {
      this.stats.referenceScans++;
      const candidate = selected.get(reference.contextId);
      if (!candidate) continue;
      assert.deepEqual(reference, candidate.identity, 'Selected reference identity mismatch');
      this.stats.referenceCandidates++;
      if (predicate(candidate)) return candidate;
    }
    return undefined;
  }
}

function bucketKey(identity, key) {
  return JSON.stringify([identity.parentId, identity.position, identity.contract, key]);
}

function boundary(bucket, order, inclusive, compare = () => {}) {
  let start = 0;
  let end = bucket.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    compare();
    if (bucket[middle].order < order || (inclusive && bucket[middle].order === order)) start = middle + 1;
    else end = middle;
  }
  return start;
}
