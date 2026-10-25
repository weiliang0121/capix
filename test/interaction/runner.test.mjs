import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interactions, InvocationCancelled, Node, Resources, Runner, Scene } from '@capix/server-runtime';
import { ResourceOffer } from '@capix/resources';

const contract = {
  key: 'runner.echo.v1',
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
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function resource(onExpose = () => {}) {
  return new ResourceOffer({
    name: 'runner.echo',
    expose: (channel, activity) => {
      const endpoint = {
        start(request) {
          return activity.runSync('start', {}, () => channel.start(request));
        },
        read(ref) {
          return activity.runSync('read', {}, () => channel.read(ref));
        },
        wait(ref, controls) {
          return activity.runAsync('wait', {}, async () => {
            try {
              return await channel.wait(ref, controls);
            } catch (error) {
              // The exchange owns no invocation. This adapter identifies this local wait's stop.
              if (controls.signal?.aborted && error === controls.signal.reason) throw new InvocationCancelled(controls.signal);
              throw error;
            }
          });
        },
      };
      onExpose(endpoint);
      return endpoint;
    },
  });
}

function scene(offer, onStart = () => {}) {
  const node = new Node({
    deps: { echo: offer.request() },
    async run(work) {
      const endpoint = work.resources.echo;
      const ref = work.input.ref ?? endpoint.start({ text: work.input.text });
      onStart(ref, endpoint);
      const result = work.input.read ? endpoint.read(ref) : await endpoint.wait(ref, { waitMs: work.input.waitMs ?? 1000, signal: work.signal });
      return { ref, result };
    },
  });
  const root = new Scene().add(node);
  Object.assign(root, {
    deps: {},
    run: async function (work) {
      const child = work.children.create(node, work.input);
      await child.run();
      return child.accept();
    },
  });
  return root;
}

test('Runner connects resource to registered interaction during build without creating endpoints or sending', async () => {
  let sends = 0;
  const endpoints = [];
  const offer = resource((endpoint) => endpoints.push(endpoint));
  const interactions = new Interactions().register(contract, {
    send(request) {
      sends += 1;
      return { text: `${request.text}:reply` };
    },
  });
  const resources = new Resources().registerInteraction(offer, contract);
  const runner = new Runner(scene(offer), resources, interactions).build();
  assert.equal(sends, 0);
  assert.equal(endpoints.length, 0);
  assert.equal(interactions.active, false);
  const first = await runner.run({ text: 'one' });
  assert.equal(first.result.feedback.payload.text, 'one:reply');
  const second = await runner.run({ text: 'two' });
  assert.equal(second.result.feedback.payload.text, 'two:reply');
  assert.notEqual(first.ref.id, second.ref.id);
  assert.equal(endpoints.length, 2);
  assert.notEqual(endpoints[0], endpoints[1]);
  assert.throws(() => endpoints[0].read(first.ref));
  assert.equal(sends, 2);
  await interactions.settled();
  interactions.close();
});

test('required interaction dependency fails before build installation and can be corrected without dispatch', async () => {
  const offer = resource();
  const resources = new Resources().registerInteraction(offer, contract);
  const root = scene(offer);
  assert.throws(() => new Runner(root, resources).build(), /requires Interactions/);
  const interactions = new Interactions();
  const runner = new Runner(root, resources, interactions);
  assert.throws(() => runner.build(), { code: 'INTERACTION_NOT_REGISTERED' });
  let sends = 0;
  interactions.register(contract, {
    send: (request) => {
      sends += 1;
      return request;
    },
  });
  assert.equal(runner.build(), runner);
  assert.equal(sends, 0);
  assert.equal((await runner.run({ text: 'after repair' })).result.kind, 'received');
  assert.equal(sends, 1);
});

test('unused interaction resource registration does not require an interaction host', async () => {
  const resources = new Resources().registerInteraction(resource(), contract);
  const root = new Scene({ run: (work) => work.input });
  const runner = new Runner(root, resources).build();
  assert.equal(await runner.run('no interaction requested'), 'no interaction requested');
});

test('A1 wait expiry releases Runner while the exchange continues; A2 uses a fresh endpoint and the same ref', async () => {
  const feedback = deferred();
  const endpoints = [];
  const offer = resource((endpoint) => endpoints.push(endpoint));
  let sends = 0;
  const interactions = new Interactions().register(contract, {
    send: () => {
      sends += 1;
      return feedback.promise;
    },
  });
  const runner = new Runner(scene(offer), new Resources().registerInteraction(offer, contract), interactions).build();
  const first = await runner.run({ text: 'input', waitMs: 0 });
  assert.equal(first.result.kind, 'wait-expired');
  assert.equal(runner.isRunning, false);
  assert.equal(interactions.active, true);
  assert.throws(() => endpoints[0].read(first.ref));
  const second = runner.run({ ref: first.ref });
  feedback.resolve({ text: 'late' });
  const received = await second;
  assert.equal(received.ref.id, first.ref.id);
  assert.equal(received.result.feedback.payload.text, 'late');
  assert.notEqual(endpoints[0], endpoints[1]);
  assert.equal(sends, 1);
  await interactions.settled();
});

test('A1 cancellation ends only its wait, and a later invocation reads the saved external feedback', async () => {
  const feedback = deferred();
  const entered = deferred();
  const offer = resource();
  let sends = 0;
  const interactions = new Interactions().register(contract, {
    send: () => {
      sends += 1;
      return feedback.promise;
    },
  });
  const root = scene(offer, (ref, endpoint) => entered.resolve({ ref, endpoint }));
  const runner = new Runner(root, new Resources().registerInteraction(offer, contract), interactions).build();
  const control = new AbortController();
  const first = runner.run({ text: 'input' }, { signal: control.signal });
  const rejected = assert.rejects(first, { code: 'INVOCATION_CANCELLED' });
  const { ref, endpoint } = await entered.promise;
  control.abort(new Error('local stop'));
  await rejected;
  assert.equal(runner.isRunning, false);
  assert.equal(interactions.active, true);
  assert.throws(() => endpoint.read(ref));
  feedback.resolve({ text: 'arrived after stop' });
  await interactions.settled();
  const second = await runner.run({ ref: JSON.parse(JSON.stringify(ref)), read: true });
  assert.equal(second.result.feedback.payload.text, 'arrived after stop');
  assert.equal(sends, 1);
  assert.equal(interactions.active, false);
});

test('new Runner and interaction host read persisted feedback through a new resource endpoint without sending', async () => {
  const stored = new Map();
  const persistence = {
    create(state) {
      stored.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      assert.equal(stored.get(state.id).revision, expectedRevision);
      stored.set(state.id, structuredClone(state));
    },
    read(id) {
      return stored.get(id);
    },
  };
  const offer = resource();
  const resources = new Resources().registerInteraction(offer, contract);
  const original = new Interactions().register(contract, { send: (request) => request, persistence });
  const first = await new Runner(scene(offer), resources, original).build().run({ text: 'retained' });
  await original.settled();
  original.close();
  const restored = new Interactions().register(contract, { send: () => assert.fail('read resent request'), persistence });
  const second = await new Runner(scene(offer), resources, restored).build().run({ ref: first.ref, read: true });
  assert.equal(second.result.feedback.payload.text, 'retained');
  assert.equal(stored.size, 1);
});
