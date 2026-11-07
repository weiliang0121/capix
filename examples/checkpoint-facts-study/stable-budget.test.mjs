import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StableValues, STABLE_VALUE_LIMITS } from './stable.mjs';

const chain = (depth) => {
  let value = null;
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
};
const dag = (depth) => {
  let value = { text: 'leaf' };
  for (let i = 0; i < depth; i++) value = { left: value, right: value };
  return value;
};
const wire = (value) => JSON.stringify({ format: 'stable-value-study@1', value });

test('deep shared DAG fixing is linear with and without cross-call reuse', () => {
  for (const reuse of [true, false]) {
    const depth = 100;
    const fixed = new StableValues({ reuse });
    const original = dag(depth);
    const value = fixed.own(original);
    assert.equal(fixed.visits, depth + 2);
    assert.equal(fixed.memoHits, depth);
    let node = value;
    for (let i = 0; i < depth; i++) {
      assert.equal(node.left, node.right);
      assert.ok(Object.isFrozen(node));
      node = node.left;
    }
    assert.equal(node.text, 'leaf');
    assert.equal(Object.isFrozen(original), false);
  }
});

test('mutable sources are never cached across calls, even when their root is frozen', () => {
  const fixed = new StableValues();
  const child = { text: 'before' };
  const raw = Object.freeze({ left: child, right: child });
  const first = fixed.own(raw);
  child.text = 'after';
  const second = fixed.own(raw);
  assert.equal(first.left.text, 'before');
  assert.equal(second.left.text, 'after');
  assert.notEqual(first, second);
  assert.equal(second.left, second.right);
  assert.notEqual(first.left, second.left);
});

test('ancestor stack rejects self and indirect cycles instead of treating them as memo hits', () => {
  const fixed = new StableValues();
  const self = {};
  self.self = self;
  const left = {};
  const right = { left };
  left.right = right;
  for (const value of [self, left]) assert.throws(() => fixed.own(value), /Cyclic/);
  const shared = {};
  assert.doesNotThrow(() => fixed.own({ first: shared, second: shared }));
});

test('depth is maximum root-to-value edges, including later memo paths', () => {
  const fixed = new StableValues({ limits: { maxDepth: 3 } });
  assert.deepEqual(fixed.own(chain(3)), chain(3));
  assert.throws(() => fixed.own(chain(4)), /depth budget/);
  const shared = { leaf: { value: null } };
  assert.throws(() => fixed.own({ shallow: shared, deep: { again: shared } }), /depth budget/);
  assert.throws(() => new StableValues().own(chain(10_000)), /depth budget/);
});

test('object and entry budgets count unique new objects and their actual fields once', () => {
  const fixed = new StableValues({ limits: { maxObjects: 2, maxEntries: 3 } });
  const shared = { text: 'x' };
  assert.doesNotThrow(() => fixed.own({ first: shared, second: shared }));
  assert.throws(() => fixed.own([{}, {}]), /objects budget/);
  assert.throws(() => fixed.own({ a: 1, b: 2, c: 3, d: 4 }), /entries budget/);
  assert.throws(() => fixed.own([1, 2, 3, 4]), /entries budget/);
  // Width is checked before descriptors are visited; no getter executes.
  let reads = 0;
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i, null]));
  Object.defineProperty(wide, 'getter', {
    enumerable: true,
    get() {
      reads++;
    },
  });
  assert.throws(() => fixed.own(wide), /entries budget/);
  assert.equal(reads, 0);
});

test('text budget counts UTF-16 key and string units; array index spelling is not charged', () => {
  const fixed = new StableValues({ limits: { maxTextUnits: 4 } });
  assert.deepEqual(fixed.own({ ab: '😀' }), { ab: '😀' });
  assert.throws(() => fixed.own({ abc: '😀' }), /textUnits budget/);
  assert.throws(() => fixed.own('abcde'), /textUnits budget/);
  assert.throws(() => fixed.encode('abcde'), /textUnits budget/);
  assert.deepEqual(fixed.own(['ab', 'cd']), ['ab', 'cd']);
  assert.throws(() => fixed.own(['ab', 'cde']), /textUnits budget/);
});

test('trusted forwarding avoids work, while new combinations retain expanded content and depth limits', () => {
  const fixed = new StableValues({ limits: { maxObjects: 3, maxEntries: 3, maxTextUnits: 8, maxDepth: 3 } });
  const root = fixed.own({ x: { y: 'hi' } });
  const before = { visits: fixed.visits, memoHits: fixed.memoHits };
  assert.equal(fixed.own(root), root);
  assert.equal(fixed.visits, before.visits);
  assert.equal(fixed.memoHits, before.memoHits);
  const wrapped = fixed.own({ a: root });
  assert.equal(wrapped.a, root);
  assert.equal(fixed.visits, before.visits + 1);
  assert.throws(() => fixed.own({ a: wrapped }), /depth budget/);
  // These limits now measure new validation work during own; old content is
  // independently bounded at encode, where it will lose its graph sharing.
  assert.throws(() => fixed.encode(fixed.own({ a: root, b: {} })), /Encoded entries budget|Encoded objects budget/);
  assert.throws(() => fixed.encode(fixed.own({ longkey: root })), /Encoded textUnits budget/);
  assert.throws(() => fixed.own({ longerkey: root }), /textUnits budget/);
  assert.equal(fixed.own(root), root);
});

test('every repeated or overlapping trusted edge contributes to expanded content', () => {
  const fixed = new StableValues({ limits: { maxObjects: 3 } });
  const root = fixed.own({ inner: {} });
  const repeated = fixed.own({ a: root, b: root });
  const overlapping = fixed.own({ a: root, b: root.inner });
  // These trees contain five and four objects respectively. Own only fixes the
  // new outer object; no whole-call proof is charged as validation work.
  assert.throws(() => fixed.encode(repeated), /Encoded objects budget/);
  assert.throws(() => fixed.encode(overlapping), /Encoded objects budget/);
  assert.equal(fixed.own(root.inner), root.inner);
});

test('an internal node has its complete reachable proof without unrelated sibling costs', () => {
  const fixed = new StableValues({ limits: { maxObjects: 3, maxEntries: 4 } });
  const shared = { leaf: null };
  const root = fixed.own({ a: shared, b: { ref: shared } });
  // b reaches the earlier a node through ref. Its summary includes that edge,
  // but excludes the original root and the unrelated root.a occurrence.
  const branch = fixed.own({ branch: root.b });
  const body = fixed.encode(branch);
  assert.deepEqual(fixed.decode(body), { branch: { ref: { leaf: null } } });
  assert.throws(() => fixed.encode(root), /Encoded objects budget/);
  assert.equal(fixed.own(root.b), root.b);
});

test('failed fixing never authenticates a mutable or unfinished parent or retains its memo', () => {
  const fixed = new StableValues();
  const child = { text: 'first' };
  const parent = { child, invalid: new Date(0) };
  assert.throws(() => fixed.own(parent), /prototype/);
  assert.throws(() => fixed.encode(parent), /requires an owned/);
  assert.throws(() => fixed.encode(child), /requires an owned/);
  assert.equal(Object.isFrozen(parent), false);
  child.text = 'revised';
  parent.invalid = undefined;
  const valid = fixed.own(parent);
  assert.equal(valid.child.text, 'revised');
  assert.equal(Object.hasOwn(valid, 'invalid'), true);
  assert.equal(valid.invalid, undefined);
});

test('tree expansion limits reject a tiny DAG before allocating any tagged tree', () => {
  const fixed = new StableValues();
  const root = fixed.own(dag(100));
  assert.equal(fixed.visits, 102);
  assert.equal(fixed.proofObjects, 101);
  assert.equal(fixed.proofEdges, 201);
  assert.equal(fixed.proofTextUnits, 908);
  assert.throws(() => fixed.encode(root), /Encoded value count budget/);
  assert.equal(fixed.encodedValues, 0);
  assert.equal(fixed.encodingProofReads, 1);
  assert.equal(fixed.proofEdges, 201, 'Encoding rejection must not rescan the old graph');
  const wrapped = fixed.own({ root });
  assert.equal(fixed.proofObjects, 102);
  assert.equal(fixed.proofEdges, 202);
  assert.equal(fixed.proofTextUnits, 912);
  assert.throws(() => fixed.encode(wrapped), /Encoded value count budget/);
  let leaf = root;
  for (let i = 0; i < 100; i++) leaf = leaf.left;
  assert.deepEqual(fixed.decode(fixed.encode(leaf)), { text: 'leaf' }, 'A saturated ancestor must not poison its small descendant');
  const bytes = new StableValues({ limits: { maxEncodedBytes: 500 } });
  assert.throws(() => bytes.encode(bytes.own(dag(8))), /Encoded byte budget/);
  assert.equal(bytes.encodedValues, 0);
});

test('fixing in different batches gives the same content admission and encoding', () => {
  for (const maxObjects of [4, 5]) {
    const limits = { maxObjects };
    const direct = new StableValues({ limits });
    const split = new StableValues({ limits });
    const raw = { inner: { text: 'shared' } };
    const whole = direct.own({ a: raw, b: raw });
    const part = split.own(raw);
    const combined = split.own({ a: part, b: part });
    if (maxObjects === 4) {
      assert.throws(() => direct.encode(whole), /Encoded objects budget/);
      assert.throws(() => split.encode(combined), /Encoded objects budget/);
    } else {
      assert.equal(direct.encode(whole), split.encode(combined));
      const edges = split.proofEdges;
      split.encode(combined);
      assert.equal(split.proofEdges, edges, 'Successful encoding must also use its cached proof');
      assert.equal(split.encodingProofReads, 2);
    }
  }
});

test('batching changes new work per own call, not the expanded content limit', () => {
  const fixed = new StableValues({ limits: { maxObjects: 2 } });
  assert.throws(() => fixed.own({ a: {}, b: {} }), /Stable objects budget/);
  const a = fixed.own({});
  const b = fixed.own({});
  const combined = fixed.own({ a, b });
  assert.throws(() => fixed.encode(combined), /Encoded objects budget/);
});

test('a different instance recomputes saturated sizes under its own fixed limits', () => {
  const low = new StableValues({ limits: { maxEncodedValues: 0, maxEncodedBytes: 0 } });
  const value = low.own(dag(4));
  assert.throws(() => low.encode(value), /Encoded value count budget/);
  const high = new StableValues();
  const copied = high.own(value);
  assert.notEqual(copied, value);
  assert.deepEqual(high.decode(high.encode(copied)), value);
  assert.throws(() => low.encode(null), /Encoded value count budget/);
});

test('wide reuse computes one summary per new edge and reads only the root proof for encoding', () => {
  const fixed = new StableValues();
  const child = fixed.own({ text: 'x'.repeat(4_000) });
  const before = { objects: fixed.proofObjects, edges: fixed.proofEdges, text: fixed.proofTextUnits };
  const repeated = fixed.own(Array(500).fill(child));
  assert.equal(fixed.proofObjects - before.objects, 1);
  assert.equal(fixed.proofEdges - before.edges, 500);
  assert.equal(fixed.proofTextUnits, before.text, 'Old strings and keys must not be rescanned for their byte length');
  assert.equal(fixed.memoHits, 499);
  const edges = fixed.proofEdges;
  assert.throws(() => fixed.encode(repeated), /Encoded textUnits budget/);
  assert.equal(fixed.encodingProofReads, 1);
  assert.equal(fixed.proofEdges, edges);
  assert.equal(fixed.encodedValues, 0);
});

test('expanded value budget has an exact boundary independent of fixing memo visits', () => {
  const raw = dag(4);
  const count = 3 * 2 ** 4 - 1;
  const accepted = new StableValues({ limits: { maxEncodedValues: count } });
  const body = accepted.encode(accepted.own(raw));
  assert.equal(accepted.encodedValues, count);
  assert.deepEqual(accepted.decode(body), accepted.own(raw));
  const denied = new StableValues({ limits: { maxEncodedValues: count - 1 } });
  assert.throws(() => denied.encode(denied.own(raw)), /Encoded value count budget/);
  assert.equal(denied.encodedValues, 0);
  assert.throws(() => denied.decode(body), /Encoded value count budget/);
});

test('successful wire output must fit fixed-data budgets again after DAG sharing is lost', () => {
  for (const [limits, raw, error] of [
    [{ maxObjects: 4 }, dag(3), /Encoded objects budget/],
    [{ maxEntries: 5 }, dag(2), /Encoded entries budget/],
    [{ maxTextUnits: 17 }, dag(1), /Encoded textUnits budget/],
  ]) {
    const fixed = new StableValues({ limits });
    const root = fixed.own(raw);
    assert.throws(() => fixed.encode(root), error);
    assert.equal(fixed.encodedValues, 0);
  }
});

test('UTF-8 encoded byte prediction is exact for tags, keys, escapes and Unicode', () => {
  for (const raw of [undefined, null, true, false, -0, 3.14, '\ud800', '😀', [], {}, [undefined, null, -0], { '😀\n': '"\\\ud800', nested: [{ x: true }] }]) {
    const fixed = new StableValues();
    const body = fixed.encode(fixed.own(raw));
    const size = Buffer.byteLength(body);
    const exact = new StableValues({ limits: { maxEncodedBytes: size } });
    assert.equal(exact.encode(exact.own(raw)), body);
    assert.deepEqual(exact.decode(body), raw);
    const short = new StableValues({ limits: { maxEncodedBytes: size - 1 } });
    assert.throws(() => short.encode(short.own(raw)), /Encoded byte budget/);
    assert.equal(short.encodedValues, 0);
    assert.throws(() => short.decode(body), /Encoded byte budget/);
  }
});

test('decoding checks semantic depth/objects/entries/text before expanding decoded subtrees', () => {
  const fixed = new StableValues({ limits: { maxDepth: 2, maxObjects: 2, maxEntries: 2, maxTextUnits: 2 } });
  assert.throws(() => fixed.decode(wire(['array', [['array', [['array', []]]]]])), /objects budget/);
  const shallow = new StableValues({ limits: { maxDepth: 1 } });
  assert.throws(() => shallow.decode(wire(['array', [['array', [['null']]]]])), /depth budget/);
  assert.throws(() => fixed.decode(wire(['array', [['null'], ['null'], ['null']]])), /entries budget/);
  assert.throws(() => fixed.decode(wire(['string', 'abc'])), /textUnits budget/);
  assert.throws(() => fixed.decode(wire(['record', [['abc', ['null']]]])), /textUnits budget/);
  const deep = '["array",['.repeat(500) + '["null"]' + ']]'.repeat(500);
  assert.throws(() => new StableValues().decode('{"format":"stable-value-study@1","value":' + deep + '}'), /depth budget/);
});

test('fixed limits reject invalid configuration and cannot be raised or mutated later', () => {
  for (const limits of [{ maxDepth: -1 }, { maxObjects: Infinity }, { maxEntries: 0.5 }, { nope: 1 }, { maxDepth: STABLE_VALUE_LIMITS.maxDepth + 1 }]) assert.throws(() => new StableValues({ limits }), /stable limit/);
  const limits = { maxEntries: 1 };
  const fixed = new StableValues({ limits });
  limits.maxEntries = 100;
  assert.throws(() => fixed.own({ a: 1, b: 2 }), /entries budget/);
});
