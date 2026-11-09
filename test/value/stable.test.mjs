import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stableValue, stableValueLimits, StableValueError } from '@weiliang0121/capix-contracts';

const rejects = (value, code = 'UNSUPPORTED_VALUE') =>
  assert.throws(
    () => stableValue(value),
    (error) => error instanceof StableValueError && error.code === code,
  );

test('stable values isolate deep ordinary data without freezing the author source', () => {
  const source = { nested: { count: 1 }, rows: [{ text: 'first' }], missing: undefined };
  const fixed = stableValue(source);
  assert.notEqual(fixed, source);
  assert.notEqual(fixed.nested, source.nested);
  assert.ok(Object.isFrozen(fixed) && Object.isFrozen(fixed.nested) && Object.isFrozen(fixed.rows) && Object.isFrozen(fixed.rows[0]));
  source.nested.count = 2;
  source.rows.push({ text: 'second' });
  assert.equal(fixed.nested.count, 1);
  assert.equal(fixed.rows.length, 1);
  assert.equal(Object.isFrozen(source), false);
  assert.throws(() => {
    fixed.rows[0].text = 'changed';
  }, TypeError);
});

test('supported scalar distinctions and record field order survive fixing', () => {
  const input = { first: undefined, second: null, third: -0, fourth: false, fifth: '', sixth: 0 };
  const fixed = stableValue(input);
  assert.deepEqual(Object.keys(fixed), Object.keys(input));
  assert.ok(Object.hasOwn(fixed, 'first'));
  assert.ok(!Object.hasOwn(fixed, 'absent'));
  assert.equal(fixed.first, undefined);
  assert.equal(fixed.second, null);
  assert.ok(Object.is(fixed.third, -0));
  assert.equal(Object.is(fixed.sixth, -0), false);
  for (const scalar of [undefined, null, true, false, '', '文本', 0, -0, 2.5]) assert.ok(Object.is(stableValue(scalar), scalar));
});

test('null-prototype records and reserved own keys remain plain stable data', () => {
  const source = Object.assign(Object.create(null), { text: 'value' });
  Object.defineProperty(source, '__proto__', { value: { ok: true }, enumerable: true });
  const fixed = stableValue(source);
  assert.equal(Object.getPrototypeOf(fixed), null);
  assert.equal(fixed.__proto__.ok, true);
  assert.equal(Object.getPrototypeOf(fixed.__proto__), Object.prototype);
});

for (const [label, value] of [
  ['function', () => {}],
  ['symbol', Symbol('hidden')],
  ['bigint', 1n],
  ['NaN', NaN],
  ['infinity', Infinity],
  ['negative infinity', -Infinity],
  ['date', new Date(0)],
  ['map', new Map()],
  ['set', new Set()],
  ['error', new Error('source')],
  ['regexp', /x/u],
  [
    'class',
    new (class Value {
      count = 1;
    })(),
  ],
  ['promise', Promise.resolve(1)],
  ['typed array', new Uint8Array([1])],
])
  test(`stable values reject ${label}`, () => rejects(value));

test('accessors, hidden fields and symbol fields are rejected without invoking value getters', () => {
  let reads = 0;
  const accessor = {
    get value() {
      reads++;
      return 1;
    },
  };
  rejects(accessor);
  assert.equal(reads, 0);
  rejects(Object.defineProperty({}, 'hidden', { value: 1 }));
  rejects({ [Symbol('field')]: 1 });
});

test('only dense ordinary arrays are accepted', () => {
  rejects(new Array(2));
  rejects([, 1]);
  rejects(Object.assign([1], { extra: 2 }));
  rejects(Object.setPrototypeOf([1], null));
  rejects(Object.defineProperty([1], '0', { value: 1, enumerable: false }));
  assert.deepEqual(stableValue([undefined, 1]), [undefined, 1]);
});

test('frozen input alone is not accepted as evidence and nested mutable data is isolated', () => {
  const nested = { count: 1 };
  const source = Object.freeze({ nested });
  const fixed = stableValue(source);
  assert.notEqual(fixed, source);
  nested.count = 2;
  assert.equal(fixed.nested.count, 1);
  rejects(Object.freeze({ method() {} }));
});

test('certified roots and subgraphs are reused exactly, without probing old bodies', () => {
  const first = stableValue({ large: { rows: Array.from({ length: 100 }, (_, index) => ({ index })) }, tiny: { value: 1 } });
  assert.equal(stableValue(first), first);
  const later = stableValue({ old: first.large, tiny: first.tiny, added: { value: 2 } });
  assert.equal(later.old, first.large);
  assert.equal(later.tiny, first.tiny);
  assert.notEqual(later.added, first.tiny);
});

test('single-call DAG memo visits each source object once and cycles remain rejected', () => {
  let descriptions = 0;
  const leaf = new Proxy(
    { text: 'leaf' },
    {
      getOwnPropertyDescriptor(target, key) {
        descriptions++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  let graph = leaf;
  for (let depth = 0; depth < 16; depth++) graph = { left: graph, right: graph };
  const fixed = stableValue(graph);
  assert.equal(descriptions, 1);
  assert.equal(fixed.left, fixed.right);
  const cycle = {};
  cycle.self = cycle;
  rejects(cycle, 'CYCLIC_VALUE');
  const array = [];
  array.push(array);
  rejects(array, 'CYCLIC_VALUE');
});

test('trusted subtree reuse accounts for expanded depth and size at every new edge', () => {
  let deep = 0;
  for (let depth = 0; depth < stableValueLimits.maxDepth; depth++) deep = { next: deep };
  const fixed = stableValue(deep);
  rejects({ next: fixed }, 'DEPTH_LIMIT');
  let branch = stableValue({ leaf: 1 });
  for (let level = 0; level < 18; level++) branch = stableValue({ left: branch, right: branch });
  rejects({ left: branch, right: branch }, 'VALUE_LIMIT');
});

test('a small child extracted from a large stable root carries its own exact quota proof', () => {
  const root = stableValue({ large: 'x'.repeat(32 * 1024 * 1024), small: { value: 'ok' } });
  const manySmall = stableValue(Array.from({ length: 1000 }, () => root.small));
  assert.equal(manySmall.length, 1000);
  assert.equal(manySmall[999], root.small);
  rejects({ first: root, second: root }, 'TEXT_LIMIT');
});

test('text limits count keys and repeated subgraphs, independently of checkpoint bytes', () => {
  const atLimit = 'x'.repeat(stableValueLimits.maxTextUnits);
  assert.equal(stableValue(atLimit), atLimit);
  rejects({ key: atLimit }, 'TEXT_LIMIT');
  const half = stableValue({ text: 'x'.repeat(stableValueLimits.maxTextUnits / 2) });
  rejects([half, half], 'TEXT_LIMIT');
});

test('array width checks reject over-budget content before copying its entries', () => {
  const source = Array(stableValueLimits.maxExpandedValues).fill(0);
  rejects(source, 'VALUE_LIMIT');
});

test('Proxy metadata failure including throw undefined always becomes a safe diagnostic', () => {
  for (const cause of [undefined, null, new Error('source')]) {
    const source = new Proxy(
      {},
      {
        ownKeys() {
          throw cause;
        },
      },
    );
    rejects(source, 'INSPECTION_FAILED');
  }
  let causeReads = 0;
  const cause = new Proxy(
    {},
    {
      get() {
        causeReads++;
        throw new Error('unreadable');
      },
      getPrototypeOf() {
        causeReads++;
        throw undefined;
      },
    },
  );
  rejects(
    new Proxy(
      {},
      {
        ownKeys() {
          throw cause;
        },
      },
    ),
    'INSPECTION_FAILED',
  );
  assert.equal(causeReads, 0);
});

test('array and record property reads use descriptors instead of ordinary get traps', () => {
  let gets = 0;
  const source = new Proxy([1, 2], {
    get() {
      gets++;
      throw new Error('do not read');
    },
  });
  assert.deepEqual(stableValue(source), [1, 2]);
  assert.equal(gets, 0);
});

test('failed sibling never turns an original mutable object into trusted evidence', () => {
  const child = { value: 1 };
  rejects({ child, invalid: () => {} });
  child.value = 2;
  const fixed = stableValue(child);
  assert.equal(fixed.value, 2);
  assert.notEqual(fixed, child);
});

test('a forged StableValueError from inspected code is never read as trusted diagnostics', () => {
  const sourceError = new StableValueError('CYCLIC_VALUE');
  Object.defineProperty(sourceError, 'code', {
    get() {
      throw new Error('code getter');
    },
  });
  rejects(
    new Proxy(
      {},
      {
        ownKeys() {
          throw sourceError;
        },
      },
    ),
    'INSPECTION_FAILED',
  );
});
