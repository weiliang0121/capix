import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { z } from 'zod';
import { Interaction, PersistenceError } from '@capix/server-runtime';
import { RuntimeError } from '@capix/contracts';

const contract = {
  key: 'test:echo:v1',
  request(value) {
    if (!value || typeof value.text !== 'string') throw new TypeError('Invalid request');
    return value;
  },
  reply(value) {
    if (!value || typeof value.text !== 'string') throw new TypeError('Invalid reply');
    return value;
  },
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function persistence() {
  const writes = [];
  return {
    writes,
    create(state) {
      writes.push(state);
    },
    commit({ expectedRevision, state }) {
      assert.equal(writes.at(-1).revision, expectedRevision);
      writes.push(state);
    },
  };
}

test('one dispatch survives an expired first waiter and a later waiter receives its retained feedback', async () => {
  const response = deferred();
  const storage = persistence();
  const interaction = new Interaction({ text: 'request' }, { contract, persistence: storage });
  let sends = 0;
  interaction.start(async (request) => {
    sends += 1;
    assert.equal(storage.writes.at(-1).delivery, 'started');
    assert.equal(request.text, 'request');
    return response.promise;
  });
  assert.deepEqual(await interaction.wait({ waitMs: 0 }), { kind: 'wait-expired' });
  const second = interaction.wait({ waitMs: 1000 });
  response.resolve({ text: 'reply' });
  const result = await second;
  assert.equal(result.kind, 'received');
  assert.equal(result.feedback.payload.text, 'reply');
  assert.equal(await interaction.wait({ waitMs: 0 }).then((value) => value.feedback), result.feedback);
  assert.equal(interaction.read().feedback, result.feedback);
  await interaction.settled();
  assert.equal(sends, 1);
  assert.deepEqual(
    storage.writes.map((state) => state.revision),
    [0, 1, 2],
  );
  assert.throws(() => interaction.start(() => ({ text: 'other' })), { code: 'INTERACTION_ALREADY_STARTED' });
  assert.equal(sends, 1);
});

test('concurrent readers share the reply and cancelling one reader does not abort delivery or another reader', async () => {
  const response = deferred();
  const first = new AbortController();
  const second = new AbortController();
  const reason = new Error('reader no longer needed');
  const interaction = new Interaction({ text: 'request' }, { contract });
  interaction.start(() => response.promise);
  const a = interaction.wait({ waitMs: 1000, signal: first.signal });
  const b = interaction.wait({ waitMs: 1000, signal: second.signal });
  const aRejected = assert.rejects(a, (error) => error === reason);
  first.abort(reason);
  await aRejected;
  assert.equal(interaction.read().kind, 'pending');
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  response.resolve({ text: 'reply' });
  const received = await b;
  assert.equal(received.kind, 'received');
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
  assert.equal((await interaction.wait({ waitMs: 0 })).feedback, received.feedback);
});

test('feedback before the deadline wins and an expired waiter is not resurrected by late feedback', async () => {
  const response = deferred();
  const signal = new AbortController().signal;
  const interaction = new Interaction({ text: 'request' }, { contract });
  interaction.start(() => response.promise);
  const expired = await interaction.wait({ waitMs: 0, signal });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  const next = interaction.wait({ waitMs: 1000, signal });
  response.resolve({ text: 'reply' });
  assert.equal((await next).kind, 'received');
  assert.deepEqual(expired, { kind: 'wait-expired' });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('request and feedback are copied and frozen independently of caller-owned data', async () => {
  const request = { text: 'request', nested: [{ enabled: true }] };
  const reply = { text: 'reply', nested: { count: 1 } };
  const interaction = new Interaction(request, { contract });
  request.text = 'changed';
  request.nested[0].enabled = false;
  interaction.start(() => reply);
  await interaction.settled();
  reply.nested.count = 2;
  const state = interaction.exportState();
  assert.equal(state.request.text, 'request');
  assert.equal(state.request.nested[0].enabled, true);
  assert.equal(state.feedback.payload.nested.count, 1);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.request.nested[0]));
  assert.ok(Object.isFrozen(state.feedback.payload.nested));
});

test('same feedback id and equivalent JSON is a no-op; conflicting feedback cannot overwrite the reply', async () => {
  const response = deferred();
  const storage = persistence();
  const interaction = new Interaction({ text: 'request' }, { contract, persistence: storage });
  interaction.start(() => response.promise);
  interaction.receive({ id: 'external-delivery', payload: { text: 'reply', count: 1 } });
  const state = interaction.exportState();
  interaction.receive({ id: 'external-delivery', payload: { count: 1, text: 'reply' } });
  assert.equal(interaction.exportState(), state);
  assert.throws(() => interaction.receive({ id: 'external-delivery', payload: { text: 'changed', count: 1 } }), { code: 'INTERACTION_FEEDBACK_CONFLICT' });
  assert.throws(() => interaction.receive({ id: 'other-delivery', payload: { text: 'reply', count: 1 } }), { code: 'INTERACTION_FEEDBACK_CONFLICT' });
  assert.equal(storage.writes.length, 3);
  response.reject(new Error('late transport failure'));
  await interaction.settled();
  assert.equal(interaction.exportState(), state);
  assert.equal(interaction.read().kind, 'received');
});

test('transport failure preserves the original error and does not claim external nonexecution', async () => {
  const failure = new RuntimeError('NETWORK_LOST', 'connection lost after send');
  const interaction = new Interaction({ text: 'request' }, { contract });
  interaction.start(() => Promise.reject(failure));
  const result = await interaction.wait({ waitMs: 1000 });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.error, failure);
  assert.equal(interaction.exportState().delivery, 'started');
  assert.equal(interaction.exportState().failure.code, failure.code);
  interaction.receive({ id: 'later-callback', payload: { text: 'reply arrived independently' } });
  assert.equal(interaction.read().kind, 'received');
  assert.equal(interaction.exportState().failure.code, failure.code);
  assert.equal(interaction.exportState().revision, 3);
});

test('contract rejection is retained as delivery capture failure without resending', async () => {
  const interaction = new Interaction({ text: 'request' }, { contract });
  interaction.start(() => ({ malformed: true }));
  await interaction.settled();
  assert.equal(interaction.read().kind, 'unavailable');
  assert.match(interaction.read().error.message, /Invalid reply/);
  assert.equal(interaction.exportState().failure.message, 'Invalid reply');
  assert.equal(interaction.exportState().feedback, undefined);
});

test('create and dispatch-intent persistence failure prevent all physical sends', async () => {
  const failure = new Error('storage failed');
  assert.throws(
    () =>
      new Interaction(
        { text: 'request' },
        {
          contract,
          persistence: {
            create() {
              throw failure;
            },
          },
        },
      ),
    (error) => error instanceof PersistenceError && error.cause === failure,
  );
  let sends = 0;
  const interaction = new Interaction(
    { text: 'request' },
    {
      contract,
      persistence: {
        create() {},
        commit() {
          throw failure;
        },
      },
    },
  );
  const waiting = interaction.wait({ waitMs: 1000 });
  assert.throws(
    () =>
      interaction.start(() => {
        sends += 1;
        return { text: 'reply' };
      }),
    (error) => error instanceof PersistenceError && error.cause === failure,
  );
  const savedFailure = (await waiting).error;
  assert.ok(savedFailure instanceof PersistenceError);
  assert.equal(savedFailure.cause, failure);
  assert.equal(interaction.read().error, savedFailure);
  assert.equal(interaction.exportState().delivery, 'prepared');
  assert.equal(interaction.exportState().revision, 0);
  assert.equal(sends, 0);
  assert.throws(
    () =>
      interaction.start(() => {
        sends += 1;
        return { text: 'reply' };
      }),
    (error) => error instanceof PersistenceError && error.cause === failure,
  );
  assert.equal(sends, 0);
});

test('reply persistence failure never exposes an uncommitted received reply or a fake pending state', async () => {
  const failure = new Error('reply store unavailable');
  const interaction = new Interaction(
    { text: 'request' },
    {
      contract,
      persistence: {
        create() {},
        commit({ state }) {
          if (state.feedback) throw failure;
        },
      },
    },
  );
  interaction.start(() => ({ text: 'reply' }));
  const result = await interaction.wait({ waitMs: 1000 });
  await interaction.settled();
  assert.ok(result.error instanceof PersistenceError);
  assert.equal(result.error.cause, failure);
  assert.equal(interaction.read().error, result.error);
  assert.equal(interaction.read().kind, 'unavailable');
  assert.equal(interaction.exportState().feedback, undefined);
  assert.equal(interaction.exportState().delivery, 'started');
  assert.equal(interaction.exportState().revision, 1);
});

test('restored received feedback can be read repeatedly without writes or a new dispatch', async () => {
  const live = new Interaction({ text: 'request' }, { contract });
  live.start(() => ({ text: 'reply' }));
  await live.settled();
  const saved = JSON.parse(JSON.stringify(live.exportState()));
  const restored = Interaction.restore(saved, {
    contract,
    persistence: {
      create() {
        assert.fail('restore wrote');
      },
      commit() {
        assert.fail('restore wrote');
      },
    },
  });
  assert.equal(restored.id, live.id);
  assert.deepEqual(restored.exportState(), live.exportState());
  saved.feedback.payload.text = 'outside mutation';
  assert.equal((await restored.wait({ waitMs: 0 })).feedback.payload.text, 'reply');
  assert.throws(() => restored.start(() => assert.fail('resent')), { code: 'INTERACTION_RESTORED' });
  assert.throws(() => restored.receive({ id: 'new', payload: { text: 'new' } }), { code: 'INTERACTION_RESTORED' });
});

test('restored prepared, unknown delivery, and delivery failures terminate reading explicitly', async () => {
  const prepared = new Interaction({ text: 'request' }, { contract });
  assert.equal((await Interaction.restore(prepared.exportState(), { contract }).wait({ waitMs: 1000 })).error.code, 'INTERACTION_RESTORED_PENDING');
  const response = deferred();
  prepared.start(() => response.promise);
  assert.equal(Interaction.restore(prepared.exportState(), { contract }).read().error.code, 'INTERACTION_RESTORED_PENDING');
  response.reject(new RuntimeError('EXTERNAL_UNKNOWN', 'delivery uncertain'));
  await prepared.settled();
  const restored = Interaction.restore(prepared.exportState(), { contract });
  assert.equal(restored.read().error.code, 'EXTERNAL_UNKNOWN');
  assert.equal(restored.exportState().delivery, 'started');
});

test('restoration rejects inconsistent progress or a mismatched data contract', () => {
  const state = new Interaction({ text: 'request' }, { contract }).exportState();
  assert.throws(() => Interaction.restore({ ...state, feedback: null }, { contract }), /Invalid persisted/);
  assert.throws(() => Interaction.restore({ ...state, unexpected: true }, { contract }), /Invalid persisted/);
  assert.throws(() => Interaction.restore({ ...state, contract: 'other:v1' }, { contract }), /Invalid persisted/);
  assert.throws(() => Interaction.restore({ ...state, revision: 1 }, { contract }), /Invalid persisted/);
  assert.throws(() => Interaction.restore({ ...state, delivery: 'started', revision: 1, feedback: { id: 'reply', payload: { text: 'reply' } } }, { contract }), /Invalid persisted/);
  assert.throws(
    () =>
      Interaction.restore(state, {
        contract: {
          ...contract,
          request() {
            return { text: 'changed by decoder' };
          },
        },
      }),
    /does not match/,
  );
});

test('wait validation and pre-aborted signals do not alter the interaction or add listeners', async () => {
  const interaction = new Interaction({ text: 'request' }, { contract });
  for (const waitMs of [-1, 0.5, Infinity, 2_147_483_648]) await assert.rejects(interaction.wait({ waitMs }), RangeError);
  const reason = new Error('already cancelled');
  const signal = AbortSignal.abort(reason);
  await assert.rejects(interaction.wait({ waitMs: 1000, signal }), (error) => error === reason);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(interaction.read().kind, 'pending');
});

test('capture rejects accessors, live objects, sparse arrays and cycles without invoking getters', () => {
  let getters = 0;
  const getter = {
    text: 'request',
    get data() {
      getters += 1;
      return 'secret';
    },
  };
  const cycle = { text: 'request' };
  cycle.self = cycle;
  for (const request of [getter, cycle, { text: 'request', data: new Date() }, { text: 'request', data: [, 1] }, { text: 'request', data: undefined }, { text: 'request', data: () => {} }]) assert.throws(() => new Interaction(request, { contract }), TypeError);
  assert.equal(getters, 0);
});

test('unsafe input is rejected before a schema can read accessors or erase unsupported properties', () => {
  let getters = 0;
  let captures = 0;
  let writes = 0;
  const schema = z.strictObject({ text: z.string() });
  const boundary = {
    key: 'strict-input:v1',
    request(value) {
      captures += 1;
      return schema.parse(value);
    },
    reply: (value) => schema.parse(value),
  };
  const inputs = [
    {
      get text() {
        getters += 1;
        return 'request';
      },
    },
    {
      text: 'request',
      get [Symbol.toStringTag]() {
        getters += 1;
        return 'Object';
      },
    },
  ];
  for (const input of inputs) {
    assert.throws(
      () =>
        new Interaction(input, {
          contract: boundary,
          persistence: {
            create() {
              writes += 1;
            },
          },
        }),
      TypeError,
    );
  }
  assert.equal(getters, 0);
  assert.equal(captures, 0);
  assert.equal(writes, 0);
});

test('feedback capture rejects envelope and payload accessors before the reply contract reads them', async () => {
  let getters = 0;
  let captures = 0;
  const response = deferred();
  const schema = z.strictObject({ text: z.string() });
  const boundary = {
    key: 'strict-feedback:v1',
    request: (value) => schema.parse(value),
    reply(value) {
      captures += 1;
      return schema.parse(value);
    },
  };
  const interaction = new Interaction({ text: 'request' }, { contract: boundary });
  interaction.start(() => response.promise);
  const feedbacks = [
    {
      get id() {
        getters += 1;
        return 'reply';
      },
      payload: { text: 'reply' },
    },
    {
      id: 'reply',
      payload: {
        get text() {
          getters += 1;
          return 'reply';
        },
      },
    },
    {
      id: 'reply',
      payload: {
        text: 'reply',
        get [Symbol.toStringTag]() {
          getters += 1;
          return 'Object';
        },
      },
    },
  ];
  for (const feedback of feedbacks) assert.throws(() => interaction.receive(feedback), TypeError);
  assert.equal(getters, 0);
  assert.equal(captures, 0);
  assert.equal(interaction.read().kind, 'pending');
  response.resolve({
    get text() {
      getters += 1;
      return 'reply';
    },
  });
  await interaction.settled();
  assert.equal(getters, 0);
  assert.equal(captures, 0);
  assert.equal(interaction.read().kind, 'unavailable');
  assert.equal(interaction.exportState().feedback, undefined);
});

test('restore rejects unsafe saved data before either data contract executes', () => {
  let getters = 0;
  let captures = 0;
  const state = new Interaction({ text: 'request' }, { contract }).exportState();
  const boundary = {
    ...contract,
    request(value) {
      captures += 1;
      return { text: value.text };
    },
    reply(value) {
      captures += 1;
      return { text: value.text };
    },
  };
  const states = [
    {
      ...state,
      get request() {
        getters += 1;
        return { text: 'request' };
      },
    },
    {
      ...state,
      request: {
        text: 'request',
        get [Symbol.toStringTag]() {
          getters += 1;
          return 'Object';
        },
      },
    },
    {
      ...state,
      delivery: 'started',
      revision: 2,
      feedback: {
        id: 'reply',
        payload: {
          get text() {
            getters += 1;
            return 'reply';
          },
        },
      },
    },
  ];
  for (const saved of states) assert.throws(() => Interaction.restore(saved, { contract: boundary }), TypeError);
  assert.equal(getters, 0);
  assert.equal(captures, 0);
});

test('contract output is still captured and cannot introduce accessors after valid input', async () => {
  let getters = 0;
  const unsafe = () => ({
    get text() {
      getters += 1;
      return 'unsafe output';
    },
  });
  assert.throws(() => new Interaction({ text: 'request' }, { contract: { ...contract, request: unsafe } }), TypeError);
  const interaction = new Interaction({ text: 'request' }, { contract: { ...contract, reply: unsafe } });
  interaction.start(() => ({ text: 'reply' }));
  await interaction.settled();
  assert.equal(interaction.read().kind, 'unavailable');
  assert.equal(getters, 0);
});

test('capture rejects proxies without running reflection or property traps', () => {
  let traps = 0;
  const input = new Proxy(
    { text: 'request' },
    {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return ['text'];
      },
      get() {
        traps += 1;
        return 'request';
      },
    },
  );
  assert.throws(() => new Interaction(input, { contract }), TypeError);
  assert.equal(traps, 0);
});

test('persistence reentry cannot cause a second dispatch or a partial feedback mutation', () => {
  let interaction;
  let sends = 0;
  interaction = new Interaction(
    { text: 'request' },
    {
      contract,
      persistence: {
        create() {},
        commit() {
          interaction.start(() => {
            sends += 1;
            return { text: 'reply' };
          });
        },
      },
    },
  );
  assert.throws(
    () =>
      interaction.start(() => {
        sends += 1;
        return { text: 'reply' };
      }),
    (error) => error instanceof PersistenceError && error.cause.code === 'INTERACTION_REENTRANT_MUTATION',
  );
  assert.equal(interaction.exportState().revision, 0);
  assert.equal(interaction.read().kind, 'unavailable');
  assert.equal(sends, 0);
});

test('async persistence ports are rejected before dispatch', () => {
  assert.throws(
    () => new Interaction({ text: 'request' }, { contract, persistence: { async create() {} } }),
    (error) => error instanceof PersistenceError && error.cause instanceof TypeError && /must be synchronous/.test(error.cause.message),
  );
  const interaction = new Interaction({ text: 'request' }, { contract, persistence: { create() {}, async commit() {} } });
  assert.throws(
    () => interaction.start(() => assert.fail('sent with async persistence')),
    (error) => error instanceof PersistenceError && error.cause instanceof TypeError && /must be synchronous/.test(error.cause.message),
  );
  assert.equal(interaction.read().kind, 'unavailable');
});

test('rejected async persistence is drained after reporting the synchronous contract violation', async () => {
  assert.throws(
    () =>
      new Interaction(
        { text: 'request' },
        {
          contract,
          persistence: {
            async create() {
              throw new Error('late create failure');
            },
          },
        },
      ),
    (error) => error instanceof PersistenceError && error.cause instanceof TypeError && /must be synchronous/.test(error.cause.message),
  );
  const interaction = new Interaction(
    { text: 'request' },
    {
      contract,
      persistence: {
        create() {},
        async commit() {
          throw new Error('late commit failure');
        },
      },
    },
  );
  assert.throws(
    () => interaction.start(() => assert.fail('sent with async persistence')),
    (error) => error instanceof PersistenceError && error.cause instanceof TypeError && /must be synchronous/.test(error.cause.message),
  );
  await new Promise((resolve) => setImmediate(resolve));
});
