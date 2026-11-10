import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';

const failures = {
  isProtected: () => false,
  isCancellation: () => false,
  describe: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
};

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function open(offer, origin = null, overrides = {}) {
  const facts = [];
  const errors = [];
  const access = new Resources()
    .register(new Resource(origin), offer)
    .bind({ resource: offer.request() })
    .open({
      contextId: 'access-host',
      failures,
      validate() {},
      error(error) {
        errors.push(error);
      },
      observation: {
        publish(fact) {
          facts.push({ ...fact, detail: fact.describe() });
        },
      },
      ...overrides,
    });
  return { access, endpoint: access.endpoints.resource, facts, errors };
}

test('closed access preserves a late successful operation fact but cannot receive the result', async () => {
  const pending = gate();
  const returned = { saved: true };
  let effected = false;
  let received = false;
  const offer = new ResourceOffer({
    methods: {
      async write() {
        await pending.promise;
        effected = true;
        return returned;
      },
    },
    observation: { methods: { write: { output: (value) => value } } },
  });
  const { access, endpoint, facts } = open(offer);
  const running = endpoint.write(undefined, {
    result: {
      succeeded() {
        received = true;
      },
    },
  });
  access.close();
  pending.resolve();
  await assert.rejects(running, /closed/i);
  assert.equal(effected, true);
  assert.equal(received, false);
  assert.equal(facts.find((fact) => fact.phase === 'returned').detail.output, returned);
  assert.throws(() => access.endpoints.resource, /closed/i);
  await assert.rejects(endpoint.write(), /closed/i);
});

test('closed access preserves the actual source failure separately from its rejected delivery', async () => {
  const pending = gate();
  const sourceFailure = new Error('disk unavailable');
  let received = false;
  const offer = new ResourceOffer({
    methods: {
      async write() {
        await pending.promise;
        throw sourceFailure;
      },
    },
  });
  const { access, endpoint, facts } = open(offer);
  const running = endpoint.write(undefined, {
    result: {
      failed() {
        received = true;
      },
    },
  });
  access.close();
  pending.resolve();
  await assert.rejects(running, (error) => error instanceof AggregateError && error.errors[0] === sourceFailure && /closed/i.test(error.errors[1].message));
  assert.equal(received, false);
  assert.equal(facts.find((fact) => fact.phase === 'threw').detail.error.message, 'disk unavailable');
});

test('closing during an asynchronous receiver prevents its later resource access and final delivery', async () => {
  const entered = gate();
  const pending = gate();
  let readCalls = 0;
  const offer = new ResourceOffer({
    methods: {
      read() {
        return ++readCalls;
      },
    },
  });
  const { access, endpoint } = open(offer);
  const running = endpoint.read(undefined, {
    result: {
      async succeeded(value) {
        entered.resolve();
        await pending.promise;
        await assert.rejects(endpoint.read(), /closed/i);
        return value;
      },
    },
  });
  await entered.promise;
  access.close();
  pending.resolve();
  await assert.rejects(running, /closed/i);
  assert.equal(readCalls, 1);
});

test('result receivers may use other endpoints while their shared access remains open', async () => {
  const unavailable = new Error('missing translation');
  const dictionary = new ResourceOffer({
    methods: {
      translate() {
        throw unavailable;
      },
    },
  });
  const fallback = new ResourceOffer({
    methods: {
      translate(origin, word) {
        return origin.get(word);
      },
    },
  });
  const errors = [];
  const access = new Resources()
    .register(new Resource(null), dictionary)
    .register(new Resource(new Map([['hello', '你好']])), fallback)
    .bind({ dictionary: dictionary.request(), fallback: fallback.request() })
    .open({ contextId: 'shared-access', failures, validate() {}, error: (error) => errors.push(error) });
  const result = await access.endpoints.dictionary.translate('hello', {
    result: {
      failed(error) {
        assert.equal(error, unavailable);
        return access.endpoints.fallback.translate('hello');
      },
    },
  });
  assert.equal(result, '你好');
  assert.deepEqual(errors, []);
  access.close();
});

test('parallel operations keep independent output gates, receivers, and operation identifiers', async () => {
  const first = gate();
  const second = gate();
  const producers = new Map();
  const offer = new ResourceOffer({
    methods: {
      async read(_origin, input, operation) {
        producers.set(input, operation);
        operation.emit(`${input}:start`);
        await (input === 'first' ? first.promise : second.promise);
        operation.emit(`${input}:end`);
        return input;
      },
    },
  });
  const { access, endpoint, facts } = open(offer);
  const firstDeltas = [];
  const secondDeltas = [];
  const a = endpoint.read('first', { delta: (delta) => firstDeltas.push(delta) });
  const b = endpoint.read('second', { delta: (delta) => secondDeltas.push(delta) });
  first.resolve();
  assert.equal(await a, 'first');
  producers.get('second').emit('second:still-open');
  second.resolve();
  assert.equal(await b, 'second');
  assert.deepEqual(firstDeltas, ['first:start', 'first:end']);
  assert.deepEqual(secondDeltas, ['second:start', 'second:still-open', 'second:end']);
  const started = facts.filter((fact) => fact.phase === 'started');
  assert.equal(started.length, 2);
  assert.notEqual(started[0].interactionId, started[1].interactionId);
  for (const start of started) assert.equal(facts.filter((fact) => fact.phase === 'returned' && fact.interactionId === start.interactionId).length, 1);
  assert.throws(() => producers.get('first').emit('late'), /output.*closed/i);
  access.close();
});

test('a strict return observer failure bypasses failed reception and retains the method failure', async () => {
  const sourceFailure = new Error('source rejected');
  const observationFailure = new Error('recording rejected');
  let fallback = false;
  let calls = 0;
  const offer = new ResourceOffer({
    methods: {
      read() {
        calls++;
        throw sourceFailure;
      },
    },
  });
  const { endpoint } = open(offer, null, {
    observation: {
      publish(fact) {
        return fact.phase === 'threw' ? observationFailure : undefined;
      },
    },
  });
  await assert.rejects(
    endpoint.read(undefined, {
      result: {
        failed() {
          fallback = true;
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, sourceFailure);
      assert.deepEqual(error.errors, [sourceFailure, observationFailure]);
      return true;
    },
  );
  assert.equal(fallback, false);
  assert.equal(calls, 1);
});

test('access closure does not abort the host signal or own the resource lifetime', async () => {
  const controller = new AbortController();
  const pending = gate();
  let completed = false;
  const origin = {
    close() {
      assert.fail('Resource lifecycle remains with its owner');
    },
  };
  const offer = new ResourceOffer({
    methods: {
      async read(_origin, _input, operation) {
        assert.equal(operation.signal, controller.signal);
        await pending.promise;
        completed = true;
        return 'late feedback';
      },
    },
  });
  const { access, endpoint } = open(offer, origin, { signal: controller.signal });
  const running = endpoint.read();
  access.close();
  access.close();
  assert.equal(controller.signal.aborted, false);
  pending.resolve();
  await assert.rejects(running, /closed/i);
  assert.equal(completed, true);
});

test('synchronous source effects survive closure while their result is refused', () => {
  let close;
  let effected = false;
  const offer = new ResourceOffer({
    expose: (_origin, activity) => ({
      write() {
        return activity.runSync('write', { output: (output) => output }, () => {
          effected = true;
          close();
          return 'saved';
        });
      },
    }),
  });
  const { access, endpoint, facts } = open(offer);
  close = () => access.close();
  assert.throws(() => endpoint.write(), /closed/i);
  assert.equal(effected, true);
  assert.equal(facts.find((fact) => fact.phase === 'returned').detail.output, 'saved');
});
