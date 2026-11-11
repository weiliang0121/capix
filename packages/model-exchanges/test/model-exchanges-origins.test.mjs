import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges, ModelExchangeViewSource, requireExchangeOriginReference, requireModelExchangeBasis, requireModelExchangeOrigin, defaultModelExchangeLimits, maximumModelExchangeLimits } from '@weiliang0121/capix-model-exchanges';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

const basis = () => ({ request: { messages: [{ role: 'user', content: 'original prefix' }], stream: true, toolChoice: 'none', responseFormat: 'json_object', maxTokens: 123, temperature: 0.5 }, catalog: { tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], digest: 'catalog-v1', policyVersion: 'policy-v1' } });
const operation = (child) => ({ parentContextId: 'parent', childContextId: child, position: 'reply' });
const reply = (calls = []) => ({ formatVersion: 1, id: 'reply', model: 'offline', output: calls.map((id) => ({ kind: 'tool-call', id, name: 'read', arguments: { encoding: 'json-text', text: '{}' } })), termination: { kind: 'completed', reason: calls.length ? 'tool_calls' : 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });

test('begin fixes the full request and catalog, confirms exact IDs and persists empty origins', () => {
  const commits = [];
  const events = [];
  const entity = new ModelExchanges({
    persistence: {
      commit(change) {
        assert.equal(entity.sequence, change.expectedSequence);
        if (change.kind === 'origin')
          assert.equal(
            entity.snapshot().origins.some((origin) => origin.id === change.origin.id),
            false,
          );
        commits.push(change);
      },
    },
    changes: {
      capture(event) {
        events.push(event);
      },
    },
  });
  const input = basis();
  const origin = entity.begin('first', input);
  input.request.messages[0].content = 'changed';
  input.catalog.tools[0].parameters.type = 'changed';
  const fixed = entity.origin(origin);
  assert.equal(fixed.request.messages[0].content, 'original prefix');
  assert.equal(fixed.catalog.tools[0].parameters.type, 'object');
  assert.ok(Object.isFrozen(fixed.catalog.tools[0].parameters));
  assert.deepEqual(entity.begin('first', basis()), origin);
  assert.equal(entity.sequence, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].kind, 'origin');
  assert.equal(commits[0].expectedSequence, 0);
  assert.equal(commits[0].origin, fixed);
  assert.equal(events[0].kind, 'origin');
  assert.equal(events[0].origin, 'first');
  assert.deepEqual(events[0].reference, origin);
  assert.deepEqual(entity.values(), []);
  const raw = structuredClone(entity.snapshot());
  assert.equal(raw.formatVersion, 2);
  assert.equal(raw.origins.length, 1);
  let effects = 0;
  const restored = ModelExchanges.restore(raw, {
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
  assert.deepEqual(restored.origin(origin), fixed);
  assert.deepEqual(restored.begin('first', basis()), origin);
  assert.equal(effects, 0);
  const changed = basis();
  changed.request.messages[0].content = 'different';
  assert.throws(() => entity.begin('first', changed));
  changed.request.messages[0].content = 'original prefix';
  changed.catalog.policyVersion = 'v2';
  assert.throws(() => entity.begin('first', changed));
  assert.equal(commits.length, 1);
});

test('origin digest canonicalizes object keys and preserves negative zero without JSON migration', () => {
  const a = basis();
  const b = { catalog: { policyVersion: a.catalog.policyVersion, digest: a.catalog.digest, tools: a.catalog.tools.map((tool) => ({ parameters: tool.parameters, description: tool.description, name: tool.name })) }, request: { temperature: 0.5, maxTokens: 123, responseFormat: 'json_object', toolChoice: 'none', stream: true, messages: [{ content: 'original prefix', role: 'user' }] } };
  const entity = new ModelExchanges();
  const ref = entity.begin('a', a);
  assert.deepEqual(entity.begin('a', b), ref);
  assert.equal(entity.begin('b', b).digest, ref.digest);
  const minus = basis();
  minus.request.temperature = -0;
  const negative = entity.begin('minus', minus);
  const zero = basis();
  zero.request.temperature = 0;
  assert.notEqual(negative.digest, entity.begin('zero', zero).digest);
  assert.ok(Object.is(entity.origin(negative).request.temperature, -0));
  assert.deepEqual(ModelExchanges.restore(structuredClone(entity.snapshot())).snapshot(), entity.snapshot());
  assert.throws(() => ModelExchanges.restore(JSON.parse(JSON.stringify(entity.snapshot()))), /origin|digest/i);
});

test('origin validation refuses authority, callbacks, undefined, accessors and proxies before evaluating them', () => {
  let evaluated = 0;
  const trap = () => {
    evaluated++;
    throw new Error('must not execute');
  };
  const variants = [
    (item) => {
      item.request.messages[0].content = undefined;
    },
    (item) => {
      item.catalog.run = () => undefined;
    },
    (item) => {
      item.catalog.node = new (class Node {})();
    },
    (item) => {
      item.request.tools = [];
    },
    (item) => {
      item.request.exchanges = [];
    },
    (item) => {
      Object.defineProperty(item.request, 'stream', { enumerable: true, get: trap });
    },
    (item) => {
      item.catalog.tools = new Proxy(item.catalog.tools, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    },
  ];
  const entity = new ModelExchanges();
  for (const mutate of variants) {
    const input = basis();
    mutate(input);
    assert.throws(() => entity.begin('invalid', input));
    assert.throws(() => requireModelExchangeBasis(input));
  }
  assert.equal(evaluated, 0);
  assert.equal(entity.sequence, 0);
  const origin = entity.begin('valid', basis());
  assert.deepEqual(requireExchangeOriginReference(origin), origin);
  assert.deepEqual(requireModelExchangeOrigin(entity.origin(origin)), entity.origin(origin));
  assert.throws(() => requireExchangeOriginReference({ ...origin, revision: 0 }));
});

test('request assembles only an exact closed ordered first-K prefix and preserves origin options', () => {
  const entity = new ModelExchanges();
  const origin = entity.begin('first', basis());
  const other = entity.begin('other', basis());
  const first = entity.intake(origin, operation('first'), reply(['call']));
  const second = entity.intake(origin, operation('second'), reply());
  assert.throws(() => entity.request({ origin, exchanges: [first] }), /missing|closed/i);
  const done = entity.complete(origin, first, 'call', { status: 'ok', content: [{ kind: 'text', text: 'done' }] });
  assert.throws(() => entity.request({ origin, exchanges: [first] }), /revision/i);
  assert.throws(() => entity.read(origin, first), /revision/i);
  assert.deepEqual(entity.read(origin, first, false), entity.read(origin, done));
  for (const exchanges of [[second], [second, done], [done, done]]) assert.throws(() => entity.request({ origin, exchanges }));
  assert.throws(() => entity.request({ origin: other, exchanges: [done] }));
  assert.throws(() => entity.request({ origin: { ...origin, digest: 'changed' }, exchanges: [] }));
  assert.throws(() => entity.request({ origin: { ...origin, id: 'missing' }, exchanges: [] }));
  const empty = entity.request({ origin, exchanges: [] });
  assert.deepEqual(empty.messages, basis().request.messages);
  const assembled = entity.request({ origin, exchanges: [done, second] });
  assert.deepEqual(assembled, { ...basis().request, tools: basis().catalog.tools, exchanges: entity.closed(origin, [done, second]).map(({ reply, feedback }) => ({ reply, feedback })) });
  const defaults = entity.begin('defaults', { request: { messages: basis().request.messages }, catalog: { tools: basis().catalog.tools, digest: 'empty', policyVersion: 'v1' } });
  const request = entity.request({ origin: defaults, exchanges: [] });
  for (const key of ['stream', 'toolChoice', 'responseFormat', 'temperature', 'maxTokens']) assert.equal(Object.hasOwn(request, key), false, key);
});

test('origins and exchanges have separate capacities and share their byte budget', () => {
  assert.equal(defaultModelExchangeLimits.origins, 10_000);
  assert.equal(maximumModelExchangeLimits.origins, 100_000);
  const entity = new ModelExchanges({ limits: { origins: 1, entries: 2 } });
  const origin = entity.begin('one', basis());
  assert.throws(() => entity.begin('two', basis()), /capacity/i);
  entity.intake(origin, operation('one'), reply());
  entity.intake(origin, operation('two'), reply());
  assert.throws(() => entity.intake(origin, operation('three'), reply()), /capacity/i);
  assert.deepEqual(entity.begin('one', basis()), origin);
  const state = entity.snapshot();
  const originBytes = Buffer.byteLength(JSON.stringify(state.origins[0]));
  const entryBytes = state.entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
  assert.throws(() => ModelExchanges.restore(state, { limits: { bytes: Math.max(originBytes, entryBytes) } }), /limits/i);
  assert.throws(() => new ModelExchanges({ limits: { bytes: originBytes - 1 } }).begin('one', basis()), /capacity/i);
  assert.equal(ModelExchanges.restore(state, { limits: { bytes: originBytes + entryBytes } }).sequence, entity.sequence);
});

test('uncertain origin persistence blocks mutations until authoritative restore without inventing success', () => {
  let saved;
  let writes = 0;
  const entity = new ModelExchanges({
    persistence: {
      commit(change) {
        writes++;
        saved = change;
        throw new Error('lost acknowledgement');
      },
    },
  });
  let failure;
  assert.throws(
    () => entity.begin('one', basis()),
    (error) => {
      failure = error;
      return error instanceof PersistenceError;
    },
  );
  assert.equal(entity.sequence, 0);
  assert.deepEqual(entity.snapshot().origins, []);
  assert.throws(
    () => entity.begin('one', basis()),
    (error) => error === failure,
  );
  assert.equal(writes, 1);
  const restored = ModelExchanges.restore({ formatVersion: 2, id: entity.id, sequence: saved.sequence, origins: [saved.origin], entries: [] });
  assert.equal(restored.begin('one', basis()).digest, saved.origin.digest);
});

test('restoration refuses missing or changed origins, old versions and impossible origin sequences', () => {
  const entity = new ModelExchanges();
  const origin = entity.begin('one', basis());
  entity.intake(origin, operation('model'), reply());
  const variants = [
    (state) => {
      state.formatVersion = 1;
    },
    (state) => {
      state.formatVersion = 1;
      delete state.origins;
    },
    (state) => {
      state.origins = [];
    },
    (state) => {
      state.origins[0].request.messages[0].content = 'forged';
    },
    (state) => {
      state.origins[0].sequence = 0;
    },
    (state) => {
      state.origins[0].sequence = 2;
    },
    (state) => {
      state.origins.push(state.origins[0]);
    },
    (state) => {
      state.entries[0].origin = 'missing';
    },
    (state) => {
      state.sequence++;
    },
  ];
  let writes = 0;
  for (const mutate of variants) {
    const state = structuredClone(entity.snapshot());
    mutate(state);
    assert.throws(() =>
      ModelExchanges.restore(state, {
        persistence: {
          commit() {
            writes++;
          },
        },
      }),
    );
  }
  assert.equal(writes, 0);
});

test('begin advances View stamps without adding members; an origin-filtered View requires an exact origin', () => {
  const entity = new ModelExchanges();
  const origin = entity.begin('one', basis());
  const source = new ModelExchangeViewSource(entity, origin);
  const before = source.index();
  assert.deepEqual(before.entries, []);
  const other = entity.begin('two', basis());
  assert.equal(source.check(before.stamp), false);
  assert.deepEqual(source.index().entries, []);
  const own = entity.intake(origin, operation('own'), reply());
  entity.intake(other, operation('other'), reply());
  assert.deepEqual(
    source.index().entries.map((entry) => entry.key),
    [own.id],
  );
  assert.deepEqual(
    entity.values(origin).map((entry) => entry.id),
    [own.id],
  );
  assert.throws(() => new ModelExchangeViewSource(entity, { ...origin, digest: 'wrong' }));
});

test('assembled requests enforce the provider aggregate limit after each retained part has passed validation', () => {
  const entity = new ModelExchanges();
  const input = basis();
  input.request.messages[0].content = 'p'.repeat(1100 * 1024);
  const origin = entity.begin('large', input);
  const incoming = reply();
  incoming.output = [{ kind: 'text', text: 'r'.repeat(1100 * 1024) }];
  const ref = entity.intake(origin, operation('large'), incoming);
  assert.equal(entity.closed(origin, [ref]).length, 1);
  assert.doesNotThrow(() => entity.request({ origin, exchanges: [] }));
  assert.throws(() => entity.request({ origin, exchanges: [ref] }), /limit|large|size/i);
  assert.equal(entity.sequence, 2);
});

test('closed reference lists reject proxies without evaluating traps', () => {
  const entity = new ModelExchanges();
  const origin = entity.begin('one', basis());
  let evaluated = 0;
  const trap = () => {
    evaluated++;
    throw new Error('must not execute');
  };
  const refs = new Proxy([], { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap });
  assert.throws(() => entity.closed(origin, refs));
  assert.equal(evaluated, 0);
});

test('origin capture enforces its outer byte limit and the inner provider request limit before persistence', () => {
  let writes = 0;
  const entity = new ModelExchanges({
    persistence: {
      commit() {
        writes++;
      },
    },
  });
  const oversizedRequest = basis();
  oversizedRequest.request.messages[0].content = 'x'.repeat(2 * 1024 * 1024);
  assert.throws(() => entity.begin('request', oversizedRequest), /limit|large|size/i);
  const oversizedOrigin = basis();
  oversizedOrigin.catalog.tools[0].description = 'x'.repeat(8 * 1024 * 1024);
  assert.throws(() => entity.begin('origin', oversizedOrigin), /limit|large|size/i);
  assert.equal(writes, 0);
  assert.equal(entity.sequence, 0);
});

test('text-only origins retain empty catalogs and assemble requests without an explicit tools field', () => {
  const entity = new ModelExchanges();
  const input = { request: { messages: [{ role: 'user', content: 'text only' }] }, catalog: { tools: [], digest: 'empty-catalog', policyVersion: 'text-v1' } };
  const origin = entity.begin('text', input);
  assert.deepEqual(entity.origin(origin).catalog.tools, []);
  const incoming = reply();
  incoming.output = [{ kind: 'text', text: 'plain answer' }];
  const ref = entity.intake(origin, operation('text'), incoming);
  const request = entity.request({ origin, exchanges: [ref] });
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.deepEqual(request.messages, input.request.messages);
  assert.deepEqual(request.exchanges, [{ reply: incoming, feedback: [] }]);
  const restored = ModelExchanges.restore(JSON.parse(JSON.stringify(entity.snapshot())));
  assert.deepEqual(restored.begin('text', input), origin);
  assert.deepEqual(restored.request({ origin, exchanges: [ref] }), request);
  assert.deepEqual(restored.snapshot(), entity.snapshot());
  assert.throws(() => entity.begin('required', { ...input, request: { ...input.request, toolChoice: 'required' } }), /tool/i);
  assert.throws(() => entity.begin('named', { ...input, request: { ...input.request, toolChoice: { name: 'read' } } }), /tool/i);
});

test('closed checks feedback slots while request also requires protocol continuation eligibility', () => {
  for (const termination of [
    { kind: 'incomplete', reason: 'length' },
    { kind: 'refused', reason: 'content_filter' },
  ]) {
    const entity = new ModelExchanges();
    const origin = entity.begin('one', basis());
    const incoming = reply();
    incoming.termination = termination;
    const ref = entity.intake(origin, operation(termination.kind), incoming);
    assert.equal(entity.closed(origin, [ref]).length, 1, 'there are no unfilled tool feedback slots');
    assert.throws(() => entity.request({ origin, exchanges: [ref] }), /complete|closed|continu|terminat/i);
    assert.equal(entity.sequence, 2);
  }
});
