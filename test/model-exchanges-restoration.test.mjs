import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges, maximumModelExchangeLimits } from '@weiliang0121/capix-model-exchanges';

const reply = () => ({ formatVersion: 1, id: 'reply', model: 'offline', output: [{ kind: 'text', text: 'retained' }], termination: { kind: 'completed', reason: 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });
function snapshot() {
  const entity = new ModelExchanges();
  entity.intake('scope', { parentContextId: 'loop', childContextId: 'model', position: 'receive' }, reply());
  return structuredClone(entity.snapshot());
}

function nodes(value) {
  return 1 + (value && typeof value === 'object' ? Object.values(value).reduce((sum, item) => sum + nodes(item), 0) : 0);
}

test('the supported entry ceiling restores even when the collection contains over two million value nodes', () => {
  const state = snapshot();
  const template = state.entries[0];
  const count = maximumModelExchangeLimits.entries;
  assert.ok(nodes(template) * count > 2_000_000, 'this exceeds the former whole-snapshot structural limit');
  state.sequence = count;
  state.entries = Array.from({ length: count }, (_, index) => ({ ...template, id: `entry-${index}`, sequence: index + 1, operation: { ...template.operation, childContextId: `model-${index}` } }));
  let effects = 0;
  const restored = ModelExchanges.restore(state, {
    limits: maximumModelExchangeLimits,
    persistence: {
      commit() {
        effects++;
      },
    },
    changes: {
      capture() {
        effects++;
      },
    },
  });
  assert.equal(restored.sequence, count);
  assert.equal(restored.values().length, count);
  const first = restored.get('entry-0');
  const last = restored.get(`entry-${count - 1}`);
  assert.equal(last.sequence, count);
  assert.ok(Object.isFrozen(last.reply.output[0]));
  assert.ok(Object.isFrozen(last.operation));
  assert.notEqual(first.reply, template.reply, 'restoration owns frozen values, not references into caller data');
  template.reply.output[0].text = 'caller changed';
  assert.equal(first.reply.output[0].text, 'retained');
  assert.equal(last.reply.output[0].text, 'retained');
  assert.throws(() => restored.intake('scope', { parentContextId: 'loop', childContextId: 'one-too-many', position: 'receive' }, reply()), /capacity/);
  assert.equal(effects, 0, 'restoration and capacity refusal do not persist or publish');
});

test('snapshot envelopes and entry arrays reject accessors, proxies, hidden fields and shape changes without running user code', () => {
  let evaluated = 0;
  const getter = () => {
    evaluated++;
    throw new Error('getter must not run');
  };
  const proxy = (value) => new Proxy(value, { getPrototypeOf: getter, getOwnPropertyDescriptor: getter, ownKeys: getter, get: getter });
  const variants = [
    ['envelope accessor', (value) => Object.defineProperty(value, 'entries', { get: getter, enumerable: true })],
    ['hidden envelope field', (value) => Object.defineProperty(value, 'id', { value: value.id, enumerable: false })],
    [
      'symbol envelope field',
      (value) => {
        value[Symbol('extra')] = true;
      },
    ],
    [
      'extra envelope field',
      (value) => {
        value.extra = true;
      },
    ],
    [
      'missing envelope field',
      (value) => {
        delete value.sequence;
      },
    ],
    ['envelope prototype', (value) => Object.setPrototypeOf(value, { inherited: true })],
    ['envelope proxy', (value) => proxy(value)],
    [
      'sparse entries',
      (value) => {
        delete value.entries[0];
      },
    ],
    ['entry accessor', (value) => Object.defineProperty(value.entries, '0', { get: getter, enumerable: true })],
    ['hidden entry', (value) => Object.defineProperty(value.entries, '0', { value: value.entries[0], enumerable: false })],
    [
      'symbol entries field',
      (value) => {
        value.entries[Symbol('extra')] = true;
      },
    ],
    [
      'extra entries field',
      (value) => {
        value.entries.extra = true;
      },
    ],
    [
      'array prototype',
      (value) => {
        Object.setPrototypeOf(value.entries, Object.create(Array.prototype));
      },
    ],
    [
      'array proxy',
      (value) => {
        value.entries = proxy(value.entries);
      },
    ],
    [
      'entry proxy',
      (value) => {
        value.entries[0] = proxy(value.entries[0]);
      },
    ],
    [
      'nested cycle',
      (value) => {
        value.entries[0].reply.native.extra = value.entries[0];
      },
    ],
  ];
  let effects = 0;
  for (const [name, mutate] of variants) {
    const value = snapshot();
    const replacement = mutate(value);
    // Mutators may return the nested object they changed; only the envelope proxy
    // replaces the supplied snapshot.
    const input = name === 'envelope proxy' ? replacement : value;
    assert.throws(
      () =>
        ModelExchanges.restore(input, {
          persistence: {
            commit() {
              effects++;
            },
          },
          changes: {
            capture() {
              effects++;
            },
          },
        }),
      undefined,
      name,
    );
  }
  assert.equal(evaluated, 0);
  assert.equal(effects, 0);
});

test('plain null-prototype envelopes remain valid and aggregate bytes are checked before publishing', () => {
  const state = snapshot();
  const plain = Object.assign(Object.create(null), state);
  assert.deepEqual(ModelExchanges.restore(plain).snapshot(), state);
  let effects = 0;
  assert.throws(
    () =>
      ModelExchanges.restore(state, {
        limits: { bytes: Buffer.byteLength(JSON.stringify(state.entries[0])) - 1 },
        changes: {
          capture() {
            effects++;
          },
        },
      }),
    /collection limits/,
  );
  assert.equal(effects, 0);
});
