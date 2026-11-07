import assert from 'node:assert/strict';

// Executable experiment, NOT a public API, production CP codec, or Proxy sandbox.
// Limits may only be lowered; each instance fixes its limits for its lifetime.
export const STABLE_VALUE_LIMITS = Object.freeze({
  maxDepth: 128,
  maxObjects: 10_000,
  maxEntries: 50_000,
  maxTextUnits: 1_048_576,
  maxEncodedValues: 100_000,
  maxEncodedBytes: 8_388_608,
});
const prefix = '{"format":"stable-value-study@1","value":';

function limitsFrom(overrides) {
  assert.ok(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'Invalid stable limits');
  for (const key of Object.keys(overrides)) assert.ok(Object.hasOwn(STABLE_VALUE_LIMITS, key), 'Unknown stable limit');
  const limits = { ...STABLE_VALUE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= STABLE_VALUE_LIMITS[key], `Invalid stable limit: ${key}`);
  return Object.freeze(limits);
}

function workBudget(limits) {
  const cost = { objects: 0, entries: 0, textUnits: 0 };
  return {
    depth(depth) {
      assert.ok(depth <= limits.maxDepth, 'Stable depth budget exceeded');
    },
    add(part) {
      for (const [name, limit] of [
        ['objects', 'maxObjects'],
        ['entries', 'maxEntries'],
        ['textUnits', 'maxTextUnits'],
      ]) {
        cost[name] += part[name] ?? 0;
        assert.ok(cost[name] <= limits[limit], `Stable ${name} budget exceeded`);
      }
    },
  };
}

export class StableValues {
  #owned = new WeakMap();
  #reuse;
  #limits;
  visits = 0;
  reused = 0;
  memoHits = 0;
  encodes = 0;
  encodedValues = 0;
  proofObjects = 0;
  proofEdges = 0;
  proofTextUnits = 0;
  encodingProofReads = 0;

  constructor({ reuse = true, limits = {} } = {}) {
    this.#reuse = reuse;
    this.#limits = limitsFrom(limits);
  }

  own(value) {
    return this.#fix(value).value;
  }

  #fix(value) {
    // These private proofs belong only to this instance's immutable limits and
    // stable-value-study@1 encoding. A proof can include saturated wire sizes:
    // successfully fixing a value does NOT promise that it can be encoded.
    const existing = this.#reuse && value && typeof value === 'object' && this.#owned.get(value);
    if (existing) {
      this.reused++;
      return { value, proof: existing };
    }
    const accounting = workBudget(this.#limits);
    const memo = new WeakMap();
    const ancestors = new Set();
    const completed = [];
    const visit = (source, depth) => {
      accounting.depth(depth);
      if (source && typeof source === 'object') {
        // Check the active path BEFORE memo: an incomplete copy is not a DAG hit.
        assert.ok(!ancestors.has(source), 'Cyclic delivery value');
        const prior = memo.get(source);
        if (prior) {
          accounting.depth(depth + prior.proof.height);
          this.memoHits++;
          return prior;
        }
        const proof = this.#reuse && this.#owned.get(source);
        if (proof) {
          accounting.depth(depth + proof.height);
          // Old bodies cause no new validation work. Their expanded content is
          // added by EVERY parent edge below, including later memo hits.
          const result = { value: source, proof };
          memo.set(source, result);
          this.reused++;
          return result;
        }
      }
      this.visits++;
      if (typeof source === 'string') {
        accounting.add({ textUnits: source.length });
        this.proofTextUnits += source.length;
      }
      if (source === undefined || source === null || typeof source === 'boolean' || typeof source === 'string' || (typeof source === 'number' && Number.isFinite(source))) return { value: source, proof: scalarProof(source, this.#limits) };
      assert.ok(source && typeof source === 'object', 'Unsupported delivery value');
      accounting.add({ objects: 1 });
      const array = Array.isArray(source);
      assert.ok(Object.getPrototypeOf(source) === (array ? Array.prototype : Object.prototype), 'Unsupported delivery prototype');
      // Reflect.ownKeys itself allocates the source's full key list; this is not
      // a hostile-object allocation sandbox. Check its width before descriptors.
      const keys = Reflect.ownKeys(source);
      const count = keys.length - (array ? 1 : 0);
      accounting.add({ entries: count });
      if (array) assert.equal(count, source.length, 'Sparse/extended arrays are unsupported');
      const owned = array ? [] : {};
      const proof = {
        height: 0,
        expanded: { objects: 1, entries: count, textUnits: 0, values: saturated(1, this.#limits.maxEncodedValues) },
        wireBytes: saturated((array ? '["array",[]]' : '["record",[]]').length, this.#limits.maxEncodedBytes),
      };
      const result = { value: owned, proof };
      this.proofObjects++;
      memo.set(source, result);
      ancestors.add(source);
      try {
        let index = 0;
        let edgeIndex = 0;
        for (const key of keys) {
          assert.equal(typeof key, 'string', 'Symbol properties are unsupported');
          if (array && key === 'length') continue;
          if (array) assert.equal(key, String(index++), 'Sparse/extended arrays are unsupported');
          else accounting.add({ textUnits: key.length });
          const descriptor = Object.getOwnPropertyDescriptor(source, key);
          assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'Accessors/non-enumerable values are unsupported');
          const child = visit(descriptor.value, depth + 1);
          proof.height = Math.max(proof.height, child.proof.height + 1);
          addExpanded(proof.expanded, child.proof.expanded, this.#limits);
          const keyUnits = array ? 0 : key.length;
          proof.expanded.textUnits = saturated(proof.expanded.textUnits + keyUnits, this.#limits.maxTextUnits);
          const overhead = (array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 3) + (edgeIndex++ > 0 ? 1 : 0);
          proof.wireBytes = saturated(proof.wireBytes + child.proof.wireBytes + overhead, this.#limits.maxEncodedBytes);
          this.proofEdges++;
          this.proofTextUnits += keyUnits;
          Object.defineProperty(owned, key, { value: child.value, enumerable: true });
        }
        Object.freeze(owned);
        Object.freeze(proof.expanded);
        Object.freeze(proof);
        completed.push(result);
        return result;
      } finally {
        ancestors.delete(source);
      }
    };
    const result = visit(value, 0);
    // Publish evidence only after the WHOLE fixing call succeeds. No unfinished
    // parent or mutable source can become trusted when a later sibling fails.
    for (const node of completed) this.#owned.set(node.value, node.proof);
    return result;
  }

  encode(value) {
    let proof;
    if (value && typeof value === 'object') {
      proof = this.#owned.get(value);
      assert.ok(proof, 'Encoding requires an owned value');
      this.encodingProofReads++;
    } else proof = this.#fix(value).proof; // No object token exists for a primitive.
    this.encodes++;
    // No body or metadata-graph scan: fixing already computed each node's
    // expanded summary. Only the actual accepted encoding expands the DAG.
    const size = proof.expanded;
    assert.ok(size.values <= this.#limits.maxEncodedValues, 'Encoded value count budget exceeded');
    assert.ok(proof.wireBytes + prefix.length + 1 <= this.#limits.maxEncodedBytes, 'Encoded byte budget exceeded');
    // A successful encoding must also fit the receiving instance's same limits
    // after sharing is lost. Fixing a DAG alone does not prove that property.
    for (const [name, limit] of [
      ['objects', 'maxObjects'],
      ['entries', 'maxEntries'],
      ['textUnits', 'maxTextUnits'],
    ])
      assert.ok(size[name] <= this.#limits[limit], `Encoded ${name} budget exceeded`);
    return prefix + JSON.stringify(encodeValue(value, () => this.encodedValues++)) + '}';
  }

  decode(body) {
    assert.equal(typeof body, 'string', 'Encoded value must be a string');
    assert.ok(body.length <= this.#limits.maxEncodedBytes && Buffer.byteLength(body) <= this.#limits.maxEncodedBytes, 'Encoded byte budget exceeded');
    const parsed = JSON.parse(body);
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid value envelope');
    assert.deepEqual(Object.keys(parsed).sort(), ['format', 'value']);
    assert.equal(parsed.format, 'stable-value-study@1', 'Incompatible value format');
    // No process-local proof comes from the wire. Parsing is byte-bounded;
    // semantic decoding checks shape/depth/counts before building each subtree.
    return this.own(decodeValue(parsed.value, this.#limits));
  }
}

function scalarTag(value) {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (typeof value === 'boolean' || typeof value === 'string') return [typeof value, value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', Object.is(value, -0) ? '-0' : String(value)];
  assert.ok(value && typeof value === 'object', 'Unsupported encoded value');
  return undefined;
}

function saturated(value, cap) {
  return Math.min(cap + 1, value);
}

function scalarProof(value, limits) {
  return Object.freeze({
    height: 0,
    expanded: Object.freeze({ objects: 0, entries: 0, textUnits: typeof value === 'string' ? value.length : 0, values: saturated(1, limits.maxEncodedValues) }),
    wireBytes: saturated(Buffer.byteLength(JSON.stringify(scalarTag(value))), limits.maxEncodedBytes),
  });
}

function addExpanded(target, child, limits) {
  for (const [name, limit] of [
    ['objects', 'maxObjects'],
    ['entries', 'maxEntries'],
    ['textUnits', 'maxTextUnits'],
    ['values', 'maxEncodedValues'],
  ])
    target[name] = saturated(target[name] + child[name], limits[limit]);
}

function encodeValue(value, count) {
  count();
  const scalar = scalarTag(value);
  if (scalar) return scalar;
  if (Array.isArray(value)) return ['array', value.map((item) => encodeValue(item, count))];
  return ['record', Object.entries(value).map(([key, item]) => [key, encodeValue(item, count)])];
}

function decodeValue(tagged, limits) {
  const accounting = workBudget(limits);
  let values = 0;
  const visit = (tagged, depth) => {
    accounting.depth(depth);
    assert.ok(++values <= limits.maxEncodedValues, 'Encoded value count budget exceeded');
    assert.ok(Array.isArray(tagged), 'Invalid value tag');
    const [tag, payload] = tagged;
    if (tag === 'undefined' || tag === 'null') {
      assert.equal(tagged.length, 1);
      return tag === 'undefined' ? undefined : null;
    }
    assert.equal(tagged.length, 2);
    if (tag === 'boolean' || tag === 'string') {
      assert.equal(typeof payload, tag);
      if (tag === 'string') accounting.add({ textUnits: payload.length });
      return payload;
    }
    if (tag === 'number') {
      assert.equal(typeof payload, 'string');
      const value = Number(payload);
      assert.ok(Number.isFinite(value));
      assert.equal(Object.is(value, -0) ? '-0' : String(value), payload, 'Noncanonical number');
      return value;
    }
    assert.ok(tag === 'array' || tag === 'record', 'Unknown value tag');
    assert.ok(Array.isArray(payload));
    accounting.add({ objects: 1, entries: payload.length });
    if (tag === 'array') return payload.map((item) => visit(item, depth + 1));
    const result = {};
    for (const entry of payload) {
      assert.ok(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string');
      const [key, value] = entry;
      accounting.add({ textUnits: key.length });
      assert.ok(!Object.hasOwn(result, key), 'Duplicate record key');
      Object.defineProperty(result, key, { value: visit(value, depth + 1), enumerable: true });
    }
    return result;
  };
  return visit(tagged, 0);
}
