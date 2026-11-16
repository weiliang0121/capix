import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_INTERACTION_TEXT_UNITS, Interaction, Interactions, MAX_INTERACTION_TEXT_UNITS } from '@weiliang0121/capix-interaction';

const contract = { key: 'data-limits:v1', request: (value) => value, reply: (value) => value };

async function received(request, reply, options = {}) {
  const interaction = new Interaction(request, { contract, ...options });
  interaction.start(() => reply);
  await interaction.settled();
  assert.equal(interaction.read().kind, 'received');
  return interaction;
}

function cold(interaction, options = {}) {
  return Interaction.restore(JSON.parse(JSON.stringify(interaction.exportState())), { contract, ...options });
}

test('default request and reply each admit 9Mi text and restore without an aggregate state budget', async () => {
  const text = 'x'.repeat(9 * 1024 * 1024);
  const live = await received({ text }, { text });
  const restored = cold(live);
  assert.deepEqual(restored.exportState(), live.exportState());
  assert.throws(() => restored.start(() => assert.fail('resent')), { code: 'INTERACTION_RESTORED' });
});

test('UTF-16 units include object keys; payload and feedback wrapper budgets are independent', async () => {
  assert.equal(DEFAULT_INTERACTION_TEXT_UNITS, 16 * 1024 * 1024);
  assert.equal(MAX_INTERACTION_TEXT_UNITS, 64 * 1024 * 1024);
  const limits = { requestTextUnits: 5, replyTextUnits: 5 };
  const live = await received({ abc: '😀' }, { abc: '😀' }, { limits });
  assert.deepEqual(cold(live, { limits }).exportState(), live.exportState());
  assert.throws(() => new Interaction({ abcd: '😀' }, { contract, limits }), /text limit/);
  const pending = new Interaction(null, { contract, limits });
  pending.start(() => new Promise(() => {}));
  const before = pending.exportState();
  assert.throws(() => pending.receive({ id: 'reply', payload: { abcd: '😀' } }), /text limit/);
  assert.equal(pending.exportState(), before);
  pending.receive({ id: 'reply-identity-does-not-consume-payload-budget', payload: { abc: '😀' } });
  assert.equal(pending.read().kind, 'received');
  assert.equal(cold(pending, { limits }).read().kind, 'received');
});

test('request capacity admits 48Mi text without increasing default reply capacity', async () => {
  const limits = { requestTextUnits: MAX_INTERACTION_TEXT_UNITS };
  const live = await received({ text: 'x'.repeat(48 * 1024 * 1024) }, 'reply', { limits });
  assert.equal(cold(live, { limits }).exportState().request.text.length, 48 * 1024 * 1024);
  assert.throws(() => cold(live), /text limit/);
  const oversizedReply = new Interaction(null, { contract, limits });
  oversizedReply.start(() => 'x'.repeat(DEFAULT_INTERACTION_TEXT_UNITS + 1));
  await oversizedReply.settled();
  assert.equal(oversizedReply.read().kind, 'unavailable');
  assert.match(oversizedReply.exportState().failure.message, /text limit/);
  assert.throws(() => oversizedReply.start(() => assert.fail('resent')), { code: 'INTERACTION_ALREADY_STARTED' });
});

test('limits are validated eagerly, snapshotted and also checked on codec output and restore', async () => {
  for (const value of [0, -1, 1.5, Infinity, NaN, MAX_INTERACTION_TEXT_UNITS + 1]) {
    for (const key of ['requestTextUnits', 'replyTextUnits']) {
      const options = { contract, limits: { [key]: value } };
      assert.throws(() => new Interaction(null, options), RangeError);
      assert.throws(() => Interaction.restore({}, options), RangeError);
      assert.throws(() => new Interactions().register(contract, { send: () => null, limits: options.limits }), RangeError);
    }
  }
  const limits = { requestTextUnits: 4, replyTextUnits: 4 };
  const live = new Interaction('four', { contract, limits });
  limits.replyTextUnits = MAX_INTERACTION_TEXT_UNITS;
  live.start(() => 'fives');
  await live.settled();
  assert.equal(live.read().kind, 'unavailable');
  assert.throws(() => new Interaction('four', { contract: { ...contract, request: () => 'fives' }, limits: { requestTextUnits: 4 } }), /text limit/);
  const saved = (await received('four', 'four')).exportState();
  assert.throws(() => Interaction.restore(saved, { contract: { ...contract, reply: () => 'fives' }, limits: { replyTextUnits: 4 } }), /text limit/);
  assert.throws(() => Interaction.restore(saved, { contract: { ...contract, reply: () => 'new' } }), /does not match/);
});

test('larger text limits leave request and reply structural budgets unchanged in hot and cold paths', async () => {
  const limits = { requestTextUnits: MAX_INTERACTION_TEXT_UNITS, replyTextUnits: MAX_INTERACTION_TEXT_UNITS };
  let deep = null;
  for (let depth = 0; depth < 65; depth += 1) deep = [deep];
  const wide = Array(100_000).fill(null);
  for (const value of [deep, wide]) {
    assert.throws(() => new Interaction(value, { contract, limits }), /structural limit/);
    const live = new Interaction(null, { contract, limits });
    live.start(() => value);
    await live.settled();
    assert.match(live.exportState().failure.message, /structural limit/);
    const saved = { ...live.exportState(), revision: 2, failure: undefined, feedback: { id: 'reply', payload: value } };
    delete saved.failure;
    assert.throws(() => Interaction.restore(saved, { contract, limits }), /structural limit/);
  }
});

test('cold state, feedback wrappers and deferred payloads reject hostile descriptors without reads or writes', async () => {
  const live = await received('request', 'reply');
  const state = live.exportState();
  let reads = 0;
  let codecs = 0;
  const getter = {
    enumerable: true,
    get() {
      reads += 1;
      return 'unsafe';
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        reads += 1;
        return [];
      },
      getPrototypeOf() {
        reads += 1;
        return Object.prototype;
      },
      get() {
        reads += 1;
        return 'unsafe';
      },
    },
  );
  const hidden = Object.defineProperty({ ...state }, 'hidden', { value: true });
  const extraFeedback = { id: 'reply', payload: 'reply', extra: true };
  const badFeedback = Object.defineProperty({ id: 'reply', payload: 'reply' }, 'payload', getter);
  const badFailure = Object.defineProperty({ code: 'FAIL', message: 'failed' }, 'message', getter);
  const options = {
    contract: {
      ...contract,
      request(value) {
        codecs += 1;
        return value;
      },
      reply(value) {
        codecs += 1;
        return value;
      },
    },
    persistence: {
      create() {
        assert.fail('restore wrote');
      },
      commit() {
        assert.fail('restore wrote');
      },
    },
  };
  for (const saved of [proxy, hidden, { ...state, extra: true }, Object.defineProperty({ ...state }, 'request', getter), { ...state, request: proxy }, { ...state, feedback: proxy }, { ...state, feedback: extraFeedback }, { ...state, feedback: badFeedback }, { ...state, feedback: { id: 'reply', payload: proxy } }, { ...state, failure: badFailure }]) {
    assert.throws(() => Interaction.restore(saved, options), TypeError);
    assert.equal(live.exportState(), state);
  }
  assert.equal(reads, 0);
  assert.equal(codecs, 0);
  const pending = new Interaction(null, { contract });
  pending.start(() => new Promise(() => {}));
  const before = pending.exportState();
  for (const feedback of [extraFeedback, badFeedback, proxy, Object.defineProperty({ id: 'reply', payload: 'reply' }, 'hidden', { value: true })]) assert.throws(() => pending.receive(feedback), TypeError);
  assert.equal(pending.exportState(), before);
  assert.equal(reads, 0);
});

test('registrations freeze limits and use them for persisted reads after eviction', async () => {
  const states = new Map();
  const limits = { requestTextUnits: DEFAULT_INTERACTION_TEXT_UNITS + 16 };
  let sends = 0;
  const interactions = new Interactions({ retained: 1 }).register(contract, {
    limits,
    send() {
      sends += 1;
      return 'reply';
    },
    persistence: {
      create(state) {
        states.set(state.id, state);
      },
      commit({ state }) {
        states.set(state.id, state);
      },
      read(id) {
        return JSON.parse(JSON.stringify(states.get(id)));
      },
    },
  });
  limits.requestTextUnits = 1;
  const channel = interactions.bind(contract);
  const first = channel.start('x'.repeat(DEFAULT_INTERACTION_TEXT_UNITS + 1));
  await interactions.settled();
  channel.start('second');
  await interactions.settled();
  assert.equal(channel.read(first).kind, 'received');
  assert.equal(sends, 2);
  assert.equal(states.size, 2);
  interactions.close();
});
