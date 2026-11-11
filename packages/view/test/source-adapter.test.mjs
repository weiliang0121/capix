import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createViewSource, View } from '@weiliang0121/capix-view';
import { conflict } from './fixtures.mjs';

function fixture() {
  let revision = 0;
  const values = new Map([
    ['first', { text: 'First', tags: ['selected'] }],
    ['second', undefined],
    ['outside', { text: 'Outside' }],
  ]);
  const calls = { keys: 0, inspect: [], read: [] };
  const requireKey = (key) => {
    if (key === 'outside' || !values.has(key)) throw new RangeError('Missing or outside scope');
  };
  const options = {
    id: 'author-content',
    scope: 'selected-range',
    version: () => String(revision),
    keys: () => {
      calls.keys++;
      return ['first', 'second'];
    },
    inspect: (key) => {
      calls.inspect.push(key);
      requireKey(key);
      return key === 'second' ? undefined : { title: key };
    },
    read: (key) => {
      calls.read.push(key);
      requireKey(key);
      return values.get(key);
    },
  };
  return { options, calls, values, change: () => revision++ };
}

test('the optional source adapter separates complete metadata, selected metadata and selected bodies', () => {
  const { options, calls, values } = fixture();
  const source = createViewSource(options);
  assert.deepEqual({ id: source.id, scope: source.scope }, { id: options.id, scope: options.scope });
  const selected = source.inspect(['second', 'first']);
  assert.deepEqual(calls, { keys: 0, inspect: ['second', 'first'], read: [] });
  assert.deepEqual(selected.entries, [
    { key: 'second', summary: undefined },
    { key: 'first', summary: { title: 'first' } },
  ]);
  const snapshot = source.read(['first', 'second'], selected.stamp);
  assert.deepEqual(calls, { keys: 0, inspect: ['second', 'first'], read: ['first', 'second'] });
  assert.equal(Object.hasOwn(snapshot.entries[1], 'value'), true);
  assert.equal(snapshot.entries[1].value, undefined, 'undefined is a present value, not a missing-key signal');
  values.get('first').text = 'Changed original';
  values.get('first').tags.push('later');
  assert.deepEqual(snapshot.entries[0].value, { text: 'First', tags: ['selected'] });
  assert.throws(() => snapshot.entries[0].value.tags.push('forbidden'), TypeError);
  const directory = source.index();
  assert.deepEqual(
    directory.entries.map((entry) => entry.key),
    ['first', 'second'],
  );
  assert.deepEqual(calls, { keys: 1, inspect: ['second', 'first', 'first', 'second'], read: ['first', 'second'] });
  assert.ok(Object.isFrozen(directory.stamp) && Object.isFrozen(directory.entries));
  assert.equal(Object.isFrozen(values.get('first')), false, 'the adapter must not freeze author-owned content');
});

test('authors retain missing-key and scope decisions without a directory scan', () => {
  const { options, calls } = fixture();
  const source = createViewSource(options);
  const stamp = source.inspect([]).stamp;
  for (const key of ['missing', 'outside']) {
    assert.throws(() => source.inspect([key]), RangeError);
    assert.throws(() => source.read([key], stamp), RangeError);
  }
  assert.equal(calls.keys, 0);
  const sources = { content: source };
  const view = new View({ revision: 0, sources: { content: { id: source.id, scope: source.scope } }, members: [{ source: 'content', key: 'second' }] });
  assert.deepEqual(view.captureSync(sources).entries, [{ source: 'content', key: 'second', value: undefined }]);
  assert.equal(calls.keys, 0);
});

test('the source adapter validates identities, source versions and unique passive keys', () => {
  for (const identity of [
    { id: '', scope: 'whole' },
    { id: 'id', scope: ' ' },
  ])
    assert.throws(() => createViewSource({ ...fixture().options, ...identity }), TypeError);
  for (const name of ['version', 'keys', 'inspect', 'read']) assert.throws(() => createViewSource({ ...fixture().options, [name]: undefined }), TypeError);
  for (const version of ['', 0, null]) assert.throws(() => createViewSource({ ...fixture().options, version: () => version }).index(), TypeError);
  for (const keys of [['first', 'first'], ['', 'first'], [-1], [0.5], [Number.MAX_SAFE_INTEGER + 1], [NaN], [null], new Set(['first']), Array(1)]) {
    const { options, calls } = fixture();
    const source = createViewSource({ ...options, keys: () => keys });
    assert.throws(() => source.index(), TypeError);
    assert.throws(() => source.inspect(keys), TypeError);
    assert.throws(() => source.read(keys, { id: source.id, scope: source.scope, version: '0' }), TypeError);
    assert.deepEqual(calls, { keys: 0, inspect: [], read: [] }, 'invalid selections must fail before metadata or body callbacks');
  }
});

test('source stamps reject changed identity, scope and version before a body callback', () => {
  const { options, calls, change } = fixture();
  const source = createViewSource(options);
  const stamp = source.index().stamp;
  for (const other of [
    { ...stamp, id: 'foreign' },
    { ...stamp, scope: 'foreign' },
    { ...stamp, version: 'later' },
  ]) {
    assert.equal(source.check(other), false);
    assert.throws(() => source.read(['first'], other), conflict);
  }
  change();
  assert.equal(source.check(stamp), false);
  assert.throws(() => source.read(['first'], stamp), conflict);
  assert.deepEqual(calls.read, []);
  assert.equal(source.read(['first'], source.inspect(['first']).stamp).entries[0].value.text, 'First');
});

test('keys, summaries and bodies cannot change their source stamp while being captured', () => {
  for (const stage of ['keys', 'inspect', 'read']) {
    const { options, change } = fixture();
    let mutate = true;
    const source = createViewSource({
      ...options,
      [stage](...args) {
        const result = options[stage](...args);
        if (mutate) {
          change();
          mutate = false;
        }
        return result;
      },
    });
    if (stage === 'read') {
      const stamp = source.inspect(['first']).stamp;
      assert.throws(() => source.read(['first'], stamp), conflict);
    } else assert.throws(() => source.index(), conflict);
    mutate = false;
    assert.equal(source.index().stamp.version, '1', 'conflicts release the local reentry guard');
  }
});

test('every source callback rejects reentry and releases its guard afterwards', () => {
  for (const stage of ['version', 'keys', 'inspect', 'read']) {
    const { options } = fixture();
    let source;
    let reenter = true;
    source = createViewSource({
      ...options,
      [stage](...args) {
        if (reenter) {
          if (stage === 'read') source.inspect(['first']);
          else source.check({ id: options.id, scope: options.scope, version: '0' });
        }
        return options[stage](...args);
      },
    });
    if (stage === 'read') assert.throws(() => source.read(['first'], { id: source.id, scope: source.scope, version: '0' }), conflict);
    else assert.throws(() => source.index(), conflict);
    reenter = false;
    assert.equal(source.inspect(['first']).entries[0].summary.title, 'first');
  }
});

test('source adapters isolate input keys and each returned item immediately', () => {
  const { options } = fixture();
  const requested = ['first', 'second'];
  const scratch = { nested: { key: '' } };
  const isolated = createViewSource({
    ...options,
    inspect(key) {
      scratch.nested.key = key;
      requested[1] = 'outside';
      return scratch;
    },
    read(key) {
      scratch.nested.key = key;
      return scratch;
    },
  });
  const inspected = isolated.inspect(requested);
  assert.deepEqual(inspected.entries, [
    { key: 'first', summary: { nested: { key: 'first' } } },
    { key: 'second', summary: { nested: { key: 'second' } } },
  ]);
  const captured = isolated.read(['first', 'second'], inspected.stamp);
  assert.deepEqual(
    captured.entries.map((entry) => entry.value.nested.key),
    ['first', 'second'],
  );
  scratch.nested.key = 'after';
  assert.equal(inspected.entries[0].summary.nested.key, 'first');
  assert.equal(Object.isFrozen(scratch), false);
});

test('source version callbacks cannot rewrite the requested keys or expected stamp before validation', () => {
  const { options, calls } = fixture();
  const requested = ['first'];
  const expected = { id: options.id, scope: options.scope, version: 'old' };
  const source = createViewSource({
    ...options,
    version() {
      requested[0] = 'second';
      expected.version = '0';
      return '0';
    },
  });
  assert.deepEqual(
    source.inspect(requested).entries.map((entry) => entry.key),
    ['first'],
  );
  requested[0] = 'first';
  expected.version = 'old';
  assert.throws(() => source.read(requested, expected), conflict);
  assert.deepEqual(calls.read, [], 'an author callback cannot repair an expected stale stamp by mutating its input');
  expected.version = 'old';
  assert.equal(source.check(expected), false);
});

test('input getters and returned accessors or proxies cannot run reentrant behavior', () => {
  const { options, calls } = fixture();
  const source = createViewSource(options);
  const stamp = source.index().stamp;
  let touched = 0;
  const getter = () => {
    touched++;
    source.index();
    return 'first';
  };
  const keys = Object.defineProperty(['first'], '0', { enumerable: true, get: getter });
  const expected = Object.defineProperty({ ...stamp }, 'version', { enumerable: true, get: getter });
  assert.throws(() => source.inspect(keys), TypeError);
  assert.throws(() => source.read(keys, stamp), TypeError);
  assert.throws(() => source.read(['first'], expected), TypeError);
  assert.throws(() => source.check(expected), TypeError);
  assert.deepEqual(calls.read, []);
  const accessor = Object.defineProperty({}, 'text', { enumerable: true, get: getter });
  const thenAccessor = Object.defineProperty({}, 'then', { enumerable: true, get: getter });
  const proxy = new Proxy({}, { ownKeys: getter, getPrototypeOf: getter });
  class LiveArray extends Array {
    [Symbol.iterator]() {
      getter();
      return super[Symbol.iterator]();
    }
  }
  const liveArray = Object.freeze(new LiveArray('first'));
  assert.throws(() => source.inspect(liveArray), TypeError);
  assert.throws(() => createViewSource({ ...options, keys: () => liveArray }).index(), TypeError);
  for (const value of [accessor, thenAccessor, proxy, liveArray, { nested: accessor }, new Map(), { capability() {} }, { value: Infinity }, { value: Symbol('unsupported') }]) {
    const invalid = createViewSource({ ...options, inspect: () => value, read: () => value });
    assert.throws(() => invalid.inspect(['first']), TypeError);
    assert.throws(() => invalid.read(['first'], stamp), TypeError);
  }
  assert.equal(touched, 0, 'passive data validation must not execute getters or proxy traps');
  assert.equal(source.check(stamp), true);
});

test('source callback selection and receiver are fixed without freezing the configuration', () => {
  const { options } = fixture();
  const source = createViewSource({
    ...options,
    label: 'original',
    inspect(key) {
      return { title: `${this.label}:${key}` };
    },
  });
  assert.equal(source.inspect(['first']).entries[0].summary.title, 'original:first');
  const bound = createViewSource(options);
  options.inspect = () => assert.fail('replaced metadata callback');
  options.read = () => assert.fail('replaced body callback');
  options.keys = () => assert.fail('replaced directory callback');
  options.version = () => assert.fail('replaced version callback');
  options.id = 'replaced';
  options.scope = 'replaced';
  assert.equal(bound.index().stamp.id, 'author-content');
  assert.equal(bound.read(['first'], bound.inspect(['first']).stamp).entries[0].value.text, 'First');
  assert.equal(Object.isFrozen(options), false);
});

test('asynchronous callback results and thenables are rejected synchronously and observed', async () => {
  for (const stage of ['version', 'keys', 'inspect', 'read']) {
    const { options } = fixture();
    const source = createViewSource({
      ...options,
      async [stage]() {
        throw new Error(`rejected ${stage}`);
      },
    });
    const invoke = stage === 'read' ? () => source.read(['first'], { id: source.id, scope: source.scope, version: '0' }) : () => source.index();
    assert.throws(invoke, TypeError);
  }
  let observed = 0;
  const thenable = {
    then(_resolve, reject) {
      observed++;
      reject(new Error('custom rejection'));
    },
  };
  const source = createViewSource({ ...fixture().options, inspect: () => thenable });
  assert.throws(() => source.inspect(['first']), TypeError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed, 1);
});
