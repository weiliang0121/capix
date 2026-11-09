import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interaction, Interactions } from '@weiliang0121/capix-interaction';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

function contract(key = 'registry.echo.v1') {
  return {
    key,
    request(value) {
      if (!value || typeof value.text !== 'string') throw new TypeError('Invalid request');
      return value;
    },
    reply(value) {
      if (!value || typeof value.text !== 'string') throw new TypeError('Invalid reply');
      return value;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function store() {
  const values = new Map();
  return {
    values,
    create(state) {
      assert.equal(values.has(state.id), false);
      values.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      assert.equal(values.get(state.id)?.revision, expectedRevision);
      values.set(state.id, structuredClone(state));
    },
    read(id) {
      return values.get(id);
    },
  };
}

test('interaction registration and binding resolve exact identity without sending or creating facts', () => {
  const boundary = contract();
  let sends = 0;
  let creates = 0;
  const exchanges = new Interactions();
  assert.equal(
    exchanges.register(boundary, {
      send() {
        sends += 1;
        return { text: 'reply' };
      },
      persistence: {
        create() {
          creates += 1;
        },
        commit() {},
      },
    }),
    exchanges,
  );
  const channel = exchanges.bind(boundary);
  assert.equal(exchanges.bind(boundary), channel);
  assert.equal(sends, 0);
  assert.equal(creates, 0);
  assert.equal(exchanges.active, false);
  assert.throws(() => exchanges.register(boundary, { send() {} }), { code: 'INTERACTION_ALREADY_REGISTERED' });
  assert.throws(() => exchanges.register(contract(), { send() {} }), { code: 'INTERACTION_ALREADY_REGISTERED' });
  assert.throws(() => exchanges.bind(contract()), { code: 'INTERACTION_CONTRACT_IDENTITY' });
  assert.throws(() => exchanges.bind(contract('missing')), { code: 'INTERACTION_NOT_REGISTERED' });
});

test('bound interaction channel fixes codecs and sender while retaining their receivers', async () => {
  const boundary = contract();
  boundary.marker = 'codec';
  boundary.reply = function (value) {
    assert.equal(this.marker, 'codec');
    return value;
  };
  const registration = {
    marker: 'sender',
    send(request) {
      assert.equal(this.marker, 'sender');
      return { text: `${request.text}:fixed` };
    },
  };
  const exchanges = new Interactions().register(boundary, registration);
  const channel = exchanges.bind(boundary);
  boundary.request = () => assert.fail('used replaced codec');
  boundary.reply = () => assert.fail('used replaced codec');
  boundary.key = 'changed';
  registration.send = () => assert.fail('used replaced sender');
  exchanges.register(contract('other'), { send: (request) => request });
  assert.throws(() => exchanges.bind(boundary), { code: 'INTERACTION_CONTRACT_CHANGED' });
  const ref = channel.start({ text: 'input' });
  assert.equal(ref.contract, 'registry.echo.v1');
  assert.ok(Object.isFrozen(ref));
  assert.ok(Object.isFrozen(channel));
  await exchanges.settled();
  assert.equal(channel.read(ref).feedback.payload.text, 'input:fixed');
});

test('a registered exchange outlives expired and cancelled waits without duplicate sending', async () => {
  const boundary = contract();
  const feedback = deferred();
  const cancellation = new AbortController();
  let sends = 0;
  const exchanges = new Interactions().register(boundary, {
    send() {
      sends += 1;
      return feedback.promise;
    },
  });
  const channel = exchanges.bind(boundary);
  const ref = channel.start({ text: 'input' });
  assert.equal(exchanges.active, true);
  assert.throws(() => exchanges.close(), { code: 'INTERACTIONS_ACTIVE' });
  assert.equal((await channel.wait(ref, { waitMs: 0 })).kind, 'wait-expired');
  const cancelled = channel.wait(ref, { waitMs: 1000, signal: cancellation.signal });
  const waiting = channel.wait(ref, { waitMs: 1000 });
  const reason = new Error('this invocation stopped');
  const rejected = assert.rejects(cancelled, (error) => error === reason);
  cancellation.abort(reason);
  await rejected;
  assert.equal(channel.read(ref).kind, 'pending');
  feedback.resolve({ text: 'late reply' });
  const received = await waiting;
  await exchanges.settled();
  assert.equal(received.kind, 'received');
  assert.equal(channel.read(ref).feedback, received.feedback);
  assert.equal(sends, 1);
  assert.equal(exchanges.active, false);
  exchanges.close();
});

test('cross-contract, unknown and mismatched persisted references cannot read or resend', async () => {
  const a = contract('a');
  const b = contract('b');
  const storage = store();
  let sends = 0;
  const exchanges = new Interactions()
    .register(a, {
      send: (request) => {
        sends += 1;
        return request;
      },
      persistence: storage,
    })
    .register(b, {
      send: (request) => {
        sends += 1;
        return request;
      },
      persistence: storage,
    });
  const ca = exchanges.bind(a);
  const cb = exchanges.bind(b);
  const ref = ca.start({ text: 'a' });
  await exchanges.settled();
  assert.throws(() => cb.read(ref), { code: 'INTERACTION_CONTRACT_MISMATCH' });
  assert.throws(
    () => cb.read({ ...ref, contract: 'b' }),
    (error) => error instanceof PersistenceError && /Invalid persisted interaction identity/.test(error.cause.message),
  );
  assert.throws(() => ca.read({ id: 'unknown', contract: 'a' }), { code: 'INTERACTION_UNKNOWN' });
  await assert.rejects(ca.wait({ id: 'unknown', contract: 'a' }, { waitMs: 0 }), { code: 'INTERACTION_UNKNOWN' });
  storage.values.set('incorrect-id', storage.values.get(ref.id));
  assert.throws(
    () => ca.read({ id: 'incorrect-id', contract: 'a' }),
    (error) => error instanceof PersistenceError && error.cause.code === 'INTERACTION_IDENTITY',
  );
  assert.equal(sends, 1);
});

test('new host restores retained replies and explicitly unavailable pending facts without sending', async () => {
  const boundary = contract();
  const storage = store();
  const live = new Interactions().register(boundary, { send: (request) => request, persistence: storage });
  const ref = live.bind(boundary).start({ text: 'persisted' });
  await live.settled();
  live.close();
  const pending = new Interaction({ text: 'pending' }, { contract: boundary, persistence: storage });
  const preparedRef = { id: pending.id, contract: boundary.key };
  const originalSize = storage.values.size;
  const restored = new Interactions().register(boundary, { send: () => assert.fail('restoration sent'), persistence: storage });
  const channel = restored.bind(boundary);
  const restoredRef = JSON.parse(JSON.stringify(ref));
  assert.equal(channel.read(restoredRef).feedback.payload.text, 'persisted');
  assert.equal((await channel.wait(restoredRef, { waitMs: 0 })).kind, 'received');
  assert.equal((await channel.wait(preparedRef, { waitMs: 1000 })).error.code, 'INTERACTION_RESTORED_PENDING');
  assert.equal(storage.values.size, originalSize);
  assert.equal(restored.active, false);
});

test('bounded completed retention never evicts active delivery; persistence can reload evicted replies', async () => {
  const boundary = contract();
  const pending = deferred();
  const storage = store();
  const exchanges = new Interactions({ retained: 1 }).register(boundary, { send: (request) => (request.text === 'pending' ? pending.promise : request), persistence: storage });
  const channel = exchanges.bind(boundary);
  const active = channel.start({ text: 'pending' });
  const first = channel.start({ text: 'first' });
  await channel.wait(first, { waitMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = channel.start({ text: 'second' });
  await channel.wait(second, { waitMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.read(active).kind, 'pending');
  assert.equal(channel.read(first).feedback.payload.text, 'first');
  assert.equal(channel.read(second).feedback.payload.text, 'second');
  pending.resolve({ text: 'finished' });
  await exchanges.settled();
  assert.equal(channel.read(active).feedback.payload.text, 'finished');
  assert.equal(storage.values.size, 3);
});

test('evicted in-memory references are explicitly unknown instead of being automatically resent', async () => {
  const boundary = contract();
  let sends = 0;
  const exchanges = new Interactions({ retained: 1 }).register(boundary, {
    send: (request) => {
      sends += 1;
      return request;
    },
  });
  const channel = exchanges.bind(boundary);
  const first = channel.start({ text: 'first' });
  await exchanges.settled();
  const second = channel.start({ text: 'second' });
  await exchanges.settled();
  assert.throws(() => channel.read(first), { code: 'INTERACTION_UNKNOWN' });
  assert.equal(channel.read(second).feedback.payload.text, 'second');
  assert.equal(sends, 2);
});

test('preparation rejects host close reentry and dispatch persistence failure prevents sending', async () => {
  const boundary = contract();
  const failure = new Error('cannot persist dispatch');
  const exchanges = new Interactions();
  let sends = 0;
  exchanges.register(boundary, {
    send() {
      sends += 1;
      return { text: 'reply' };
    },
    persistence: {
      create() {
        assert.throws(() => exchanges.close(), { code: 'INTERACTIONS_ACTIVE' });
      },
      commit() {
        throw failure;
      },
    },
  });
  assert.throws(
    () => exchanges.bind(boundary).start({ text: 'input' }),
    (error) => error instanceof PersistenceError && error.cause === failure,
  );
  await exchanges.settled();
  assert.equal(exchanges.active, false);
  assert.equal(sends, 0);
  exchanges.close();
});

test('passive observer failure is isolated and closed hosts revoke previously bound channels', async () => {
  const boundary = contract();
  let notifications = 0;
  const exchanges = new Interactions().register(boundary, {
    send: (request) => request,
    observation: {
      receive() {
        notifications += 1;
        throw new Error('observer failed');
      },
    },
  });
  const channel = exchanges.bind(boundary);
  const ref = channel.start({ text: 'input' });
  await exchanges.settled();
  assert.equal(channel.read(ref).kind, 'received');
  assert.equal(notifications, 1);
  exchanges.close();
  exchanges.close();
  assert.throws(() => channel.start({ text: 'again' }), { code: 'INTERACTIONS_CLOSED' });
  assert.throws(() => channel.read(ref), { code: 'INTERACTIONS_CLOSED' });
  await assert.rejects(channel.wait(ref, { waitMs: 0 }), { code: 'INTERACTIONS_CLOSED' });
  assert.throws(() => exchanges.bind(boundary), { code: 'INTERACTIONS_CLOSED' });
  assert.throws(() => exchanges.register(contract('other'), { send() {} }), { code: 'INTERACTIONS_CLOSED' });
});

test('invalid registration and retention fail before work; async persistence reads are rejected and drained', async () => {
  for (const retained of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => new Interactions({ retained }), RangeError);
  const exchanges = new Interactions();
  assert.throws(() => exchanges.register(contract(''), { send() {} }), TypeError);
  const boundary = contract();
  assert.throws(() => exchanges.register(boundary, { send: 1 }), TypeError);
  assert.throws(() => exchanges.register(boundary, { send() {}, persistence: { create() {} } }), TypeError);
  exchanges.register(boundary, {
    send: () => assert.fail('read triggered dispatch'),
    persistence: {
      create() {},
      commit() {},
      async read() {
        throw new Error('asynchronous storage failed');
      },
    },
  });
  assert.throws(
    () => exchanges.bind(boundary).read({ id: 'missing', contract: boundary.key }),
    (error) => error instanceof PersistenceError && error.cause instanceof TypeError && /reads must be synchronous/.test(error.cause.message),
  );
  await new Promise((resolve) => setImmediate(resolve));
});

test('host shutdown during persisted lookup cannot return a resource from the closed host', () => {
  const boundary = contract();
  const state = new Interaction({ text: 'saved' }, { contract: boundary }).exportState();
  const exchanges = new Interactions();
  exchanges.register(boundary, {
    send: () => assert.fail('read triggered dispatch'),
    persistence: {
      create() {},
      commit() {},
      read() {
        exchanges.close();
        return state;
      },
    },
  });
  const channel = exchanges.bind(boundary);
  assert.throws(() => channel.read({ id: state.id, contract: boundary.key }), { code: 'INTERACTIONS_CLOSED' });
});
