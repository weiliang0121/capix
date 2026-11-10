import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interactions } from '@weiliang0121/capix-interaction';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { Interaction } from '@weiliang0121/capix-interaction';

const contract = (key = 'pending-count.echo') => ({ key, request: (value) => value, reply: (value) => value });

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('pendingCount aggregates live registrations and survives cancellation or expiry of local waits', async () => {
  const a = contract('a');
  const b = contract('b');
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const interactions = new Interactions().register(a, { send: () => first.promise }).register(b, { send: () => second.promise });
  assert.equal(interactions.pendingCount, 0);
  const ca = interactions.bind(a);
  const cb = interactions.bind(b);
  const refA = ca.start('first');
  const refB = cb.start('second');
  assert.equal(interactions.pendingCount, 2);
  assert.equal((await ca.wait(refA, { waitMs: 0 })).kind, 'wait-expired');
  const cancellation = new AbortController();
  const reason = new Error('local wait ended');
  const waiting = assert.rejects(cb.wait(refB, { waitMs: 1000, signal: cancellation.signal }), (error) => error === reason);
  cancellation.abort(reason);
  await waiting;
  assert.equal(interactions.pendingCount, 2);
  first.resolve('first reply');
  await tick();
  assert.equal(ca.read(refA).kind, 'received');
  assert.equal(interactions.pendingCount, 1);
  assert.throws(() => interactions.close(), { code: 'INTERACTIONS_ACTIVE' });
  second.resolve('late second reply');
  await interactions.settled();
  assert.equal(interactions.pendingCount, 0);
  assert.equal(cb.read(refB).feedback.payload, 'late second reply');
  interactions.close();
  assert.equal(interactions.pendingCount, 0);
});

test('sender return does not decrement pendingCount before reply validation and feedback persistence', async () => {
  const phases = [];
  const interactions = new Interactions();
  const capture = (phase) => phases.push([phase, interactions.pendingCount]);
  const boundary = {
    ...contract(),
    reply(value) {
      capture('validate');
      return value;
    },
  };
  interactions.register(boundary, {
    send(request) {
      capture('send');
      return request;
    },
    persistence: {
      create() {},
      commit({ state }) {
        if (state.feedback) capture('persist');
      },
    },
    observation: {
      receive(fact) {
        if (fact.state.feedback) capture('observed');
      },
    },
  });
  interactions.bind(boundary).start('reply');
  await interactions.settled();
  assert.deepEqual(phases, [
    ['send', 1],
    ['validate', 1],
    ['persist', 1],
    ['observed', 1],
  ]);
  assert.equal(interactions.pendingCount, 0);
  interactions.close();
});

test('sender, reply and persistence failures release the count only after delivery cleanup', async (t) => {
  for (const phase of ['send', 'reply', 'persist']) {
    await t.test(phase, async () => {
      const failure = new Error(`${phase} failed`);
      const interactions = new Interactions();
      const samples = [];
      const boundary = {
        ...contract(),
        reply(value) {
          samples.push(interactions.pendingCount);
          if (phase === 'reply') throw failure;
          return value;
        },
      };
      interactions.register(boundary, {
        send(request) {
          if (phase === 'send') throw failure;
          return request;
        },
        persistence: {
          create() {},
          commit({ state }) {
            if (state.feedback || state.failure) samples.push(interactions.pendingCount);
            if (state.feedback && phase === 'persist') throw failure;
          },
        },
        observation: {
          receive(fact) {
            if (fact.type === 'unavailable') samples.push(interactions.pendingCount);
          },
        },
      });
      const channel = interactions.bind(boundary);
      const ref = channel.start('request');
      assert.equal(interactions.pendingCount, 1);
      await interactions.settled();
      assert.ok(samples.length > 0);
      assert.ok(samples.every((count) => count === 1));
      assert.equal(interactions.pendingCount, 0);
      const result = channel.read(ref);
      assert.equal(result.kind, 'unavailable');
      if (phase === 'persist') {
        assert.ok(result.error instanceof PersistenceError);
        assert.equal(result.error.cause, failure);
      } else assert.equal(result.error, failure);
      interactions.close();
    });
  }
});

test('preparation and installed callbacks have precise reentrant counts without double counting', async () => {
  const interactions = new Interactions();
  const observations = [];
  const boundary = { ...contract(), progress: (value) => value };
  const save = (phase) => {
    observations.push([phase, interactions.pendingCount, interactions.active]);
    assert.throws(() => interactions.close(), { code: 'INTERACTIONS_ACTIVE' });
  };
  let channel;
  interactions.register(boundary, {
    send: (request) => request,
    persistence: {
      create(state) {
        save(`create:${state.request}`);
        if (state.request === 'outer') {
          channel.start('inner');
          save('inner-installed');
        }
      },
      commit({ state }) {
        if (!state.feedback) save(`started:${state.request}`);
      },
    },
    progressObservation: {
      receive(fact) {
        if (fact.phase === 'created') save('installed');
      },
    },
  });
  channel = interactions.bind(boundary);
  channel.start('outer');
  assert.equal(interactions.pendingCount, 2);
  assert.deepEqual(observations, [
    ['create:outer', 0, true],
    ['create:inner', 0, true],
    ['installed', 1, true],
    ['started:inner', 1, true],
    ['inner-installed', 1, true],
    ['installed', 2, true],
    ['started:outer', 2, true],
  ]);
  await interactions.settled();
  assert.equal(interactions.pendingCount, 0);
  interactions.close();
});

test('failed preparation or dispatch installation leaves no pending entry and never sends', async (t) => {
  for (const phase of ['create', 'commit']) {
    await t.test(phase, async () => {
      const interactions = new Interactions();
      const boundary = contract();
      const failure = new Error('storage failure');
      interactions.register(boundary, {
        send() {
          assert.fail('failed installation cannot send');
        },
        persistence: {
          create() {
            assert.equal(interactions.pendingCount, 0);
            if (phase === 'create') throw failure;
          },
          commit() {
            assert.equal(interactions.pendingCount, 1);
            throw failure;
          },
        },
      });
      assert.throws(
        () => interactions.bind(boundary).start('request'),
        (error) => error instanceof PersistenceError && error.cause === failure,
      );
      assert.equal(interactions.pendingCount, 0);
      assert.equal(interactions.active, false);
      await interactions.settled();
      interactions.close();
    });
  }
});

test('read-only restored feedback and unavailable pending facts never count as live delivery', async () => {
  const boundary = contract();
  const original = new Interaction('request', { contract: boundary });
  const prepared = original.exportState();
  original.start(() => 'reply');
  await original.settled();
  const received = original.exportState();
  for (const state of [prepared, received]) {
    const interactions = new Interactions().register(boundary, {
      send() {
        assert.fail('read-only restoration cannot send');
      },
      persistence: {
        create() {
          assert.fail('restore cannot write');
        },
        commit() {
          assert.fail('restore cannot write');
        },
        read: () => state,
      },
    });
    const result = interactions.bind(boundary).read({ id: state.id, contract: boundary.key });
    assert.equal(result.kind, state.feedback ? 'received' : 'unavailable');
    assert.equal(interactions.pendingCount, 0);
    assert.equal(interactions.active, false);
    interactions.close();
  }
});
