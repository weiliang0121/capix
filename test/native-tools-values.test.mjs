import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, collectionLimit, fixed, valueLimit } from '../examples/native-tools/value.mjs';
import { ModelExchanges, feedbackDigest } from '../examples/native-tools/exchanges.mjs';
import { createCatalog, precheck, validateCatalog } from '../examples/native-tools/catalog.mjs';
import { InteractionJournal } from '../examples/native-tools/measurement.mjs';
import { acceptReply } from '../examples/native-tools/protocol.mjs';
import { toolReply } from '../examples/native-tools/fixtures.mjs';

const operation = (index = 0) => ({ parentContextId: 'parent', childContextId: `child-${index}`, position: 'model-reply' });
const result = (text) => ({ status: 'ok', content: [{ kind: 'text', text }] });
const reverseKeys = (value) =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reverseKeys(child)]),
        )
      : value;
const entries = [{ name: 'read_text', description: 'Read a file.', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, member: { position: 0, contract: 'read', version: 1 } }];
const call = { kind: 'tool-call', id: 'call-read', name: 'read_text', arguments: { encoding: 'json-text', text: '{"path":"notes.md"}' } };

test('native values reject non-JSON values before getters or Proxy traps can execute', () => {
  let effects = 0;
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      effects++;
      return 'unsafe';
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        effects++;
        return Object.prototype;
      },
    },
  );
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [getter, proxy, cyclic, new Map(), new Date(), undefined, { value: undefined }, { value: () => {} }, { [Symbol('value')]: 1 }, [, 1], NaN, Infinity]) assert.throws(() => fixed(value), TypeError);
  assert.equal(effects, 0);
  assert.throws(() => fixed('x'.repeat(valueLimit + 1)), /byte limit/);
  assert.throws(() => fixed('value', Infinity), /positive integer/);
  assert.throws(() => fixed('x'.repeat(collectionLimit + 1), collectionLimit), /byte limit/);
  const value = fixed({ a: [{ b: 'c' }] });
  assert.ok(Object.isFrozen(value.a[0]));
});

test('native feedback digests and intake receipts ignore JSON object key order across restoration', () => {
  const feedback = { toolCallId: 'call-read', ...result('text') };
  assert.equal(feedbackDigest(feedback), feedbackDigest(reverseKeys(feedback)));
  assert.equal(canonical({ b: 2, a: [1, 2] }), canonical({ a: [1, 2], b: 2 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  const entity = new ModelExchanges();
  const reply = acceptReply(toolReply());
  const ref = entity.intake('scope', operation(), reply);
  assert.deepEqual(entity.intake('scope', reverseKeys(operation()), reverseKeys(reply)), ref);
  const restored = ModelExchanges.restore(reverseKeys(entity.snapshot()));
  assert.deepEqual(restored.intake('scope', operation(), reply), ref);
  assert.equal(restored.snapshot().entries.length, 1);
  const duplicate = structuredClone(entity.snapshot());
  duplicate.entries.push({ ...duplicate.entries[0], id: 'different-id', operation: reverseKeys(operation()) });
  assert.throws(() => ModelExchanges.restore(duplicate), /Duplicate exchange receipt/);
});

test('exchange aggregate snapshots may exceed one-value limits without enlarging reply or feedback limits', () => {
  const entity = new ModelExchanges();
  const reply = acceptReply(toolReply());
  const content = 'x'.repeat(Math.ceil(valueLimit * 0.6));
  for (let index = 0; index < 2; index++) {
    const ref = entity.intake('scope', operation(index), reply);
    entity.complete('scope', ref, 'call-read', result(content));
  }
  const snapshot = entity.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > valueLimit);
  assert.deepEqual(ModelExchanges.restore(snapshot).snapshot(), snapshot);
  const tooLarge = structuredClone(snapshot);
  tooLarge.entries[0].feedback[0].content[0].text = 'x'.repeat(valueLimit + 1);
  assert.throws(() => ModelExchanges.restore(tooLarge), /byte limit/);
  const oversizedReply = structuredClone(snapshot);
  oversizedReply.entries[0].reply.output[0].text = 'x'.repeat(valueLimit + 1);
  assert.throws(() => ModelExchanges.restore(oversizedReply), /byte limit/);
  const getter = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      assert.fail('restore must not evaluate getters');
    },
  });
  assert.throws(() => ModelExchanges.restore(getter), /accessors/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => ModelExchanges.restore(cyclic), /acyclic/);
  const getterRef = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      assert.fail('closed must not evaluate reference getters');
    },
  });
  assert.throws(() => entity.closed('scope', [getterRef]), /accessors/);
  const getterList = Object.defineProperty([], 0, {
    enumerable: true,
    get() {
      assert.fail('closed must not evaluate list getters');
    },
  });
  assert.throws(() => entity.closed('scope', getterList), /accessors/);
});

test('interaction snapshots preserve multiple bounded values and reject an oversized individual request', () => {
  const journal = new InteractionJournal();
  const content = 'x'.repeat(Math.ceil(valueLimit * 0.6));
  const state = (id) => ({ id, contract: 'fixture', revision: 1, request: { content }, delivery: 'started', feedback: { id: `feedback-${id}`, payload: { content } } });
  journal.create(state('a'));
  journal.create(state('b'));
  const snapshot = journal.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 2 * valueLimit);
  assert.deepEqual(InteractionJournal.restore(snapshot).snapshot(), snapshot);
  const large = structuredClone(snapshot);
  large[0].request.content = 'x'.repeat(valueLimit + 1);
  assert.throws(() => InteractionJournal.restore(large), /byte limit/);
  const getter = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      assert.fail('journal must not evaluate getters');
    },
  });
  assert.throws(() => journal.create(getter), /accessors/);
  assert.equal(journal.writes, 2);
  assert.throws(() => InteractionJournal.restore([snapshot[0], snapshot[0]]), /Duplicate saved interaction/);
});

test('catalog reuse trusts only authenticated frozen identities and rechecks deserialized values', () => {
  const catalog = createCatalog(entries);
  assert.ok(Object.isFrozen(catalog.snapshot.entries[0].schema.properties.path));
  assert.equal(validateCatalog(catalog, catalog), catalog);
  assert.equal(precheck(catalog, call).kind, 'accepted');
  const raw = structuredClone(catalog);
  assert.equal(precheck(raw, call).kind, 'accepted');
  raw.snapshot.entries[0].schema.properties.path.type = 'number';
  assert.throws(() => precheck(raw, call), /catalog changed/);
  const unsupported = structuredClone(catalog);
  unsupported.snapshot.entries[0].schema.patternProperties = {};
  assert.throws(() => precheck(unsupported, call));
  const getter = Object.defineProperty({}, 'snapshot', {
    enumerable: true,
    get() {
      assert.fail('catalog must not evaluate getters');
    },
  });
  assert.throws(() => precheck(getter, call), /accessors/);
  const restored = validateCatalog(catalog, reverseKeys(catalog));
  assert.notEqual(restored, catalog);
  assert.equal(precheck(restored, call).kind, 'accepted');
});
