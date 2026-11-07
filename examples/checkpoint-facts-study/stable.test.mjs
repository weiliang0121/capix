import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableValues } from './stable.mjs';

test('serialization isolates the producer but does not fix the consumer value', () => {
  const raw = { nested: { text: 'original' } };
  const copied = JSON.parse(JSON.stringify(raw));
  raw.nested.text = 'producer change';
  assert.equal(copied.nested.text, 'original');
  const facts = Object.freeze({ returned: copied });
  copied.nested.text = 'consumer change';
  assert.equal(facts.returned.nested.text, 'consumer change');
});

test('owned delivery protects producer aliases, consumer writes, and an independent sibling reader', () => {
  const raw = { items: [{ text: 'original' }] };
  const stable = new StableValues();
  const delivered = stable.own(raw);
  const sibling = stable.own(delivered);
  raw.items[0].text = 'producer change';
  assert.throws(() => {
    delivered.items[0].text = 'consumer change';
  }, TypeError);
  assert.throws(() => delivered.items.push({ text: 'extra' }), TypeError);
  assert.equal(Reflect.deleteProperty(delivered.items[0], 'text'), false);
  assert.equal(sibling.items[0].text, 'original');
  // Never freeze a producer-owned alias as an incidental side effect.
  assert.equal(Object.isFrozen(raw.items[0]), false);
  const draft = structuredClone(delivered);
  draft.items[0].text = 'local draft';
  assert.equal(delivered.items[0].text, 'original');
});

test('reuse is optional for meaning; multi-level forwarding need not recopy a known stable payload', (t) => {
  function forward(reuse) {
    const stable = new StableValues({ reuse });
    const returned = stable.own({ text: 'child', nested: { amount: 7 } });
    const before = stable.visits;
    const accepted = stable.own(returned);
    const ancestor = stable.own(accepted);
    const facts = [Object.freeze({ id: 'child/returned', value: returned }), Object.freeze({ id: 'parent/accepted', value: accepted }), Object.freeze({ id: 'parent/returned', value: ancestor })];
    assert.equal(new Set(facts.map((fact) => fact.id)).size, 3);
    return { values: facts.map((fact) => fact.value), visits: stable.visits - before };
  }
  const shared = forward(true);
  const copied = forward(false);
  assert.deepEqual(shared.values, copied.values);
  assert.equal(shared.visits, 0);
  assert.ok(copied.visits > 0);
  assert.equal(shared.values[0], shared.values[2]);
  assert.notEqual(copied.values[0], copied.values[2]);
  t.diagnostic(JSON.stringify({ reuseAdditionalVisits: shared.visits, fallbackAdditionalVisits: copied.visits }));
  // Fact IDs here are illustrative. This is not proof of parent-child authority.
});

test('foreign owners are safely copied; equal content is not an invocation or fact identity', () => {
  const first = new StableValues();
  const second = new StableValues();
  const original = first.own({ text: 'same' });
  assert.throws(() => second.encode(original), /requires an owned/);
  const admitted = second.own(original);
  assert.notEqual(admitted, original);
  assert.deepEqual(admitted, original);
  const equal = second.own({ text: 'same' });
  assert.notEqual(admitted, equal);
  assert.equal(second.encode(admitted), second.encode(equal));
});

test('reusing fixed contents does not skip a different consumer contract', () => {
  const stable = new StableValues();
  const value = stable.own({ amount: 7 });
  const visited = stable.visits;
  let checks = 0;
  const consume = (candidate, minimum) => {
    const received = stable.own(candidate);
    checks++;
    assert.ok(received.amount >= minimum, 'Consumer requirement failed');
    return received;
  };
  assert.equal(consume(value, 5), value);
  assert.throws(() => consume(value, 10), /Consumer requirement failed/);
  assert.equal(stable.visits, visited);
  assert.equal(checks, 2);
});

test('the value contract excludes alias topology: normal and restored consumers use contents, not ===', () => {
  const child = { text: 'shared' };
  const stable = new StableValues();
  const owned = stable.own(child);
  const input = stable.own({ left: owned, right: owned });
  const restored = new StableValues().decode(stable.encode(input));
  assert.equal(input.left, input.right); // Local fast-path sharing.
  assert.notEqual(restored.left, restored.right); // No identity promise on the wire.
  assert.deepEqual(input, restored);
  const consume = (value) => `${value.left.text}/${value.right.text}`;
  assert.equal(consume(input), consume(restored));
});

test('CP off and on keep the same meaning; second save encodes only newly submitted facts in the sketch', (t) => {
  function run(save) {
    const stable = new StableValues();
    const representations = new Map();
    const encodeCalls = [];
    const persistNew = (facts) => {
      if (!save) return;
      for (const fact of facts) {
        assert.ok(!representations.has(fact.id), 'The sketch takes ONLY newly established facts');
        representations.set(fact.id, stable.encode(fact.value));
        encodeCalls.push(fact.id);
      }
    };
    const input = stable.own({ query: 'hello', options: { locale: undefined } });
    const raw = { text: 'hello', revision: 7 };
    const returned = stable.own(raw);
    const accepted = stable.own({ text: returned.text.toUpperCase(), revision: returned.revision });
    raw.text = 'changed before the first save';
    const facts = [
      { id: 'I1', value: input },
      { id: 'O1', value: returned },
      { id: 'A1', value: accepted },
    ];
    persistNew(facts);
    const first = encodeCalls.length;
    const next = stable.own({ text: `${accepted.text}!`, revision: 8 });
    persistNew([{ id: 'O2', value: next }]);
    assert.equal(encodeCalls.slice(first).includes('O1'), false);
    return { meaning: [input, returned, accepted, next], encodes: stable.encodes, encodeCalls, representations };
  }
  const off = run(false);
  const on = run(true);
  assert.deepEqual(off.meaning, on.meaning);
  assert.equal(off.encodes, 0);
  assert.deepEqual(on.encodeCalls, ['I1', 'O1', 'A1', 'O2']);
  t.diagnostic(JSON.stringify({ offEncodes: off.encodes, onEncodes: on.encodes, firstSave: ['I1', 'O1', 'A1'], secondSave: ['O2'] }));
  // This proves the immutable-data prerequisite, NOT incremental production CP
  // capture, atomic persistence, recovery eligibility, or bounded Frame size.
});

test('normalization is explicit before formal data; checks cannot silently rewrite a delivery', () => {
  const stable = new StableValues();
  const raw = { text: '  keep or normalize explicitly  ', date: new Date(0) };
  assert.throws(() => stable.own(raw), /prototype/);
  const normalized = { text: raw.text.trim(), epochMs: raw.date.getTime() };
  const delivered = stable.own(normalized);
  assert.equal(typeof delivered.epochMs, 'number');
  assert.throws(() => {
    delivered.text = 'hidden check normalization';
  }, TypeError);
  const restored = new StableValues().decode(stable.encode(delivered));
  assert.deepEqual(restored, delivered);
  const unnormalized = stable.own({ text: raw.text });
  assert.equal(new StableValues().decode(stable.encode(unnormalized)).text, raw.text);
});

test('restoring formal data does not repeat a non-idempotent business transformation', () => {
  const stable = new StableValues();
  let transformations = 0;
  let checks = 0;
  const transform = (raw) => {
    transformations++;
    return { text: `[accepted] ${raw.text}` };
  };
  const check = (value) => {
    checks++;
    assert.equal(typeof value.text, 'string');
  };
  const value = stable.own(transform({ text: 'message' }));
  check(value);
  const restored = new StableValues().decode(stable.encode(value));
  check(restored);
  assert.deepEqual(restored, value);
  assert.equal(transformations, 1);
  assert.equal(checks, 2);
  // An already accepted value is decoded, not fed into its business receiver.
  assert.notDeepEqual(transform(restored), value);
});

test('candidate conversion failure does not publish a fact, while an earlier established fact remains', () => {
  const stable = new StableValues();
  const published = [];
  const publish = (candidate, check) => {
    const value = stable.own(candidate);
    check(value);
    published.push(value);
    return value;
  };
  const first = publish({ text: 'established' }, () => {});
  let effects = 0;
  const business = () => {
    effects++;
    return { output: new Map() };
  };
  assert.throws(() => publish(business(), () => {}), /prototype/);
  const checkFailure = new Error('business check');
  assert.throws(
    () =>
      publish({ text: 'candidate' }, () => {
        throw checkFailure;
      }),
    (error) => error === checkFailure,
  );
  assert.equal(effects, 1);
  assert.deepEqual(published, [first]);
  // Synchronous sketch. It does not prescribe RuntimeError attribution or
  // promise that preceding external effects are rolled back.
});

test('undefined, absent keys, null and signed zero survive the candidate representation distinctly', () => {
  const stable = new StableValues();
  const value = stable.own({ present: undefined, nullable: null, values: [undefined, -0, 0, null], text: '\ud800' });
  const restored = new StableValues().decode(stable.encode(value));
  assert.deepEqual(restored, value);
  assert.equal(Object.hasOwn(restored, 'present'), true);
  assert.equal(Object.hasOwn(restored, 'missing'), false);
  assert.equal(Object.is(restored.values[1], -0), true);
  assert.equal(Object.is(restored.values[2], 0), true);
  assert.equal(new StableValues().decode(stable.encode(undefined)), undefined);
  const ordinary = JSON.parse(JSON.stringify(value));
  assert.equal(Object.hasOwn(ordinary, 'present'), false);
  assert.equal(ordinary.values[0], null);
  assert.equal(Object.is(ordinary.values[1], -0), false);
});

test('unsupported objects reject without running getters/toJSON; data keys cannot forge type tags', () => {
  const stable = new StableValues();
  let executed = 0;
  const getter = Object.defineProperty({}, 'text', {
    enumerable: true,
    get() {
      executed++;
      return 'getter';
    },
  });
  const withToJSON = {
    toJSON() {
      executed++;
      return 'converted';
    },
  };
  const cycle = {};
  cycle.self = cycle;
  const hidden = Object.defineProperty({}, 'secret', { value: 7 });
  for (const value of [getter, withToJSON, cycle, hidden, new Date(), new Map(), new Uint8Array([1]), new Error('live error'), NaN, Infinity, 1n, Symbol('x'), [, 1]]) assert.throws(() => stable.own(value));
  assert.equal(executed, 0);
  const literal = JSON.parse('{"__proto__":{"data":true},"value":["undefined"],"format":"stable-value-study@1"}');
  const value = stable.own(literal);
  const restored = stable.decode(stable.encode(value));
  assert.equal(Object.hasOwn(restored, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.deepEqual(restored, value);
});

test('restoration rejects malformed/unsupported representations instead of coercing their meaning', () => {
  const stable = new StableValues();
  const wire = (value) => JSON.stringify({ format: 'stable-value-study@1', value });
  for (const value of [
    ['number', 'NaN'],
    ['number', '01'],
    ['boolean', 'false'],
    ['undefined', 0],
    ['date', '2020'],
    [
      'record',
      [
        ['x', ['null']],
        ['x', ['undefined']],
      ],
    ],
  ])
    assert.throws(() => stable.decode(wire(value)));
  assert.throws(() => stable.decode(JSON.stringify({ format: 'stable-value-study@2', value: ['null'] })), /Incompatible/);
  let coerced = 0;
  assert.throws(
    () =>
      stable.decode({
        toString() {
          coerced++;
          return wire(['null']);
        },
      }),
    /must be a string/,
  );
  assert.equal(coerced, 0);
});

test('a shared DAG is fixed once per source object but still expands in the tree representation', (t) => {
  const stable = new StableValues();
  let graph = { text: 'leaf' };
  const depth = 8;
  for (let index = 0; index < depth; index++) graph = { left: graph, right: graph };
  const owned = stable.own(graph);
  const body = stable.encode(owned);
  assert.equal(stable.visits, depth + 2);
  assert.equal(stable.memoHits, depth);
  assert.equal(owned.left, owned.right);
  assert.equal(stable.encodedValues, 3 * 2 ** depth - 1);
  const before = stable.visits;
  assert.equal(stable.own(owned), owned);
  assert.equal(stable.visits, before);
  t.diagnostic(JSON.stringify({ sourceObjects: depth + 1, fixingVisits: stable.visits, expandedEncodedValues: stable.encodedValues, encodedBytes: Buffer.byteLength(body) }));
  // Fixing now preserves local sharing. Persistence remains a bounded tree:
  // its separately measured expansion cost is not the fixing cost.
});

test('fresh process independently validates and fixes restored values before consumer access', () => {
  const stable = new StableValues();
  const raw = { text: 'original', optional: undefined, nested: [{ zero: -0 }] };
  const value = stable.own(raw);
  const bodies = [stable.encode(value), stable.encode(undefined)];
  raw.text = 'changed later';
  const directory = mkdtempSync(join(tmpdir(), 'capix-stable-delivery-'));
  const path = join(directory, 'values.json');
  try {
    writeFileSync(path, JSON.stringify(bodies), { mode: 0o600 });
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./stable-restore.mjs', import.meta.url)), path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    const restored = JSON.parse(child.stdout);
    assert.deepEqual(restored.bodies, bodies);
    assert.ok(restored.visits > 0);
    assert.equal(restored.protectedObjects, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
