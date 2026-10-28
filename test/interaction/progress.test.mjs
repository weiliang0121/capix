import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interactions } from '@capix/interaction';

const contract = {
  key: 'progress.test.v1',
  request: (value) => value,
  reply: (value) => {
    if (typeof value !== 'string') throw new TypeError('reply must be text');
    return value;
  },
  progress: (value) => {
    if (typeof value !== 'string') throw new TypeError('progress must be text');
    return value;
  },
};
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const next = (reader) => reader.next({ waitMs: 1000 });

test('process metadata has no payload, and recursive creation disables only its observer', async () => {
  const facts = [];
  const failures = [];
  let channel;
  let sends = 0;
  const interactions = new Interactions().register(contract, {
    send(request, progress) {
      sends++;
      progress.publish(request);
      return request;
    },
    progressObservation: {
      receive(fact) {
        facts.push(fact);
        assert.equal('value' in fact, false);
        assert.equal('request' in fact, false);
        if (fact.phase === 'created') {
          const reader = channel.openProgress({ id: fact.interactionId, contract: contract.key });
          assert.equal(reader.position.sequence, 0);
          reader.close();
          channel.start('nested');
        }
      },
      failed(error) {
        failures.push(error);
      },
    },
  });
  channel = interactions.bind(contract);
  const ref = channel.start('outer');
  await interactions.settled();
  assert.equal(sends, 2);
  assert.equal(facts.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(channel.read(ref).feedback.payload, 'outer');
  interactions.close();
});

test('invalid progress policies fail at registration before any request is persisted', () => {
  let created = 0;
  const registration = {
    send: String,
    progress: { maxBytes: 0 },
    persistence: {
      create() {
        created++;
      },
      commit() {},
    },
  };
  assert.throws(() => new Interactions().register(contract, registration), RangeError);
  assert.equal(created, 0);
});

test('independent production, replay, continuation and final feedback use one send', async () => {
  const started = deferred();
  const finish = deferred();
  let writer;
  let sends = 0;
  const interactions = new Interactions().register(contract, {
    async send(_request, progress) {
      sends++;
      writer = progress;
      progress.publish('one');
      progress.publish('two');
      started.resolve();
      await finish.promise;
      progress.publish('three');
      return 'final';
    },
  });
  const channel = interactions.bind(contract);
  const ref = channel.start('request');
  await started.promise;
  const first = channel.openProgress(ref);
  const one = await next(first);
  assert.equal(one.value, 'one');
  first.close();
  const resumed = channel.openProgress(ref, one.cursor);
  assert.equal((await next(resumed)).value, 'two');
  const waiting = next(resumed);
  finish.resolve();
  assert.equal((await waiting).value, 'three');
  assert.deepEqual(await next(resumed), { kind: 'sealed', lastSequence: 3 });
  await interactions.settled();
  assert.equal(channel.read(ref).feedback.payload, 'final');
  assert.equal(writer.publish('late').kind, 'sealed');
  assert.equal(sends, 1);
  interactions.close();
});

test('process sealing does not prove reply validation or persistence succeeded', async () => {
  const interactions = new Interactions().register(contract, {
    send(_request, progress) {
      progress.publish('candidate');
      return 42;
    },
  });
  const channel = interactions.bind(contract);
  const ref = channel.start('request');
  await interactions.settled();
  const reader = channel.openProgress(ref);
  assert.equal((await next(reader)).value, 'candidate');
  assert.equal((await next(reader)).kind, 'sealed');
  assert.equal(channel.read(ref).kind, 'unavailable');
  interactions.close();
});

test('progress overflow does not persist chunks or invalidate the final reply', async () => {
  const saved = new Map();
  const revisions = [];
  const persistence = {
    create(state) {
      saved.set(state.id, state);
      revisions.push(state.revision);
    },
    commit({ state }) {
      saved.set(state.id, state);
      revisions.push(state.revision);
    },
    read(id) {
      return saved.get(id);
    },
  };
  let sends = 0;
  const registration = {
    progress: { maxEntries: 1 },
    persistence,
    send(_request, progress) {
      sends++;
      progress.publish('one');
      assert.equal(progress.publish('two').kind, 'unavailable');
      return 'saved';
    },
  };
  const interactions = new Interactions().register(contract, registration);
  const channel = interactions.bind(contract);
  const ref = channel.start('request');
  await interactions.settled();
  assert.equal((await next(channel.openProgress(ref))).kind, 'unavailable');
  assert.deepEqual(revisions, [0, 1, 2]);
  assert.equal(channel.read(ref).feedback.payload, 'saved');
  assert.equal('progress' in saved.get(ref.id), false);
  interactions.close();
  const restored = new Interactions().register(contract, registration);
  const fresh = restored.bind(contract);
  assert.equal((await next(fresh.openProgress(ref))).kind, 'unavailable');
  assert.equal(fresh.read(ref).feedback.payload, 'saved');
  assert.equal(sends, 1);
  restored.close();
});

test('eviction invalidates retained readers and host close wakes pending process reads', async () => {
  const finish = deferred();
  const interactions = new Interactions({ retained: 1 }).register(contract, {
    async send(request, progress) {
      if (request === 'active') await finish.promise;
      progress.publish(request);
      return request;
    },
  });
  const channel = interactions.bind(contract);
  const ref = channel.start('old');
  await interactions.settled();
  const old = channel.openProgress(ref);
  channel.start('new');
  await interactions.settled();
  assert.equal((await next(old)).kind, 'unavailable');
  assert.equal((await next(channel.openProgress(ref))).kind, 'unavailable');
  const active = channel.start('active');
  const reader = channel.openProgress(active);
  assert.throws(() => interactions.close(), { code: 'INTERACTIONS_ACTIVE' });
  finish.resolve();
  await interactions.settled();
  interactions.close();
  assert.equal((await next(reader)).kind, 'unavailable');
});

test('shared process budget is returned by invalidation and eviction', async () => {
  const interactions = new Interactions({ retained: 1, progress: { maxBytes: 6 } }).register(contract, {
    send(request, progress) {
      progress.publish(request);
      return request;
    },
  });
  const channel = interactions.bind(contract);
  const a = channel.start('abc'); // JSON UTF-8 is 5 bytes
  await interactions.settled();
  assert.equal((await next(channel.openProgress(a))).kind, 'item');
  const b = channel.start('def');
  await interactions.settled();
  assert.equal((await next(channel.openProgress(b))).kind, 'unavailable');
  const c = channel.start('ghi');
  await interactions.settled();
  assert.equal((await next(channel.openProgress(c))).kind, 'item');
  interactions.close();
});

test('progress codecs are fixed at registration and local read cancellation never stops production', async () => {
  const definition = { ...contract, progress: contract.progress };
  const finish = deferred();
  const interactions = new Interactions().register(definition, {
    async send(_request, progress) {
      await finish.promise;
      progress.publish('late');
      return 'final';
    },
  });
  definition.progress = () => {
    throw new Error('replaced');
  };
  const channel = interactions.bind(definition);
  const ref = channel.start('request');
  const reader = channel.openProgress(ref);
  const abort = new AbortController();
  const reason = new Error('reader cancelled');
  const rejected = assert.rejects(reader.next({ waitMs: 1000, signal: abort.signal }), (error) => error === reason);
  abort.abort(reason);
  await rejected;
  reader.close();
  finish.resolve();
  await interactions.settled();
  assert.equal((await next(channel.openProgress(ref))).value, 'late');
  assert.equal(channel.read(ref).feedback.payload, 'final');
  assert.throws(() => channel.openProgress({ ...ref, contract: 'other' }), { code: 'INTERACTION_CONTRACT_MISMATCH' });
  assert.throws(() => channel.openProgress(ref, { interactionId: 'other', sequence: 0 }));
  interactions.close();
});
