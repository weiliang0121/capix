import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callableHooks, InvocationCancelled, Node, Resources, Runner, Scene } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { CallableBinder, CallableBuilder, callableConstruction } from '@weiliang0121/capix-runtime/construction';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { ResourceOffer } from '@weiliang0121/capix-resources';

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
  let bindings = 0;
  const resources = new Resources().registerBinding(offer, () => {
    bindings++;
    return interactions.bind(contract);
  });
  assert.equal(bindings, 0);
  const runner = new Runner(scene(offer), resources).build();
  assert.equal(bindings, 1);
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
  assert.equal(bindings, 1);
  await interactions.settled();
  interactions.close();
});

test('required interaction dependency fails before build installation and can be corrected without dispatch', async () => {
  const offer = resource();
  const interactions = new Interactions();
  const resources = new Resources().registerBinding(offer, () => interactions.bind(contract));
  const root = scene(offer);
  assert.throws(() => new Runner(root, new Resources()).build(), /Expected one resource provider/);
  const runner = new Runner(root, resources);
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

test('build rejects a different contract with the same key and rejects an asynchronous supply', () => {
  const offer = resource();
  const root = scene(offer);
  const interactions = new Interactions().register(contract, { send: () => assert.fail('unexpected dispatch') });
  const resources = new Resources().registerBinding(offer, () => interactions.bind({ ...contract }));
  assert.throws(() => new Runner(root, resources).build(), { code: 'INTERACTION_CONTRACT_IDENTITY' });
  const asynchronous = new Resources().registerBinding(offer, async () => interactions.bind(contract));
  assert.throws(() => new Runner(root, asynchronous).build(), /Resource binding must be synchronous/);
});

test('Runner, CallableBuilder and CallableBinder reject former argument positions before installing a supply', () => {
  class HostWithOptions extends Interactions {
    get active() {
      assert.fail('legacy host detection must not read active');
    }
    validate() {
      assert.fail('legacy host must not supply validation');
    }
  }
  const offer = resource();
  const root = scene(offer);
  const resources = new Resources().registerBinding(offer, () => assert.fail('legacy arguments must fail before resolving supplies'));
  const construct = (...args) => new Runner(...args);
  const builder = new CallableBuilder();
  const binder = new CallableBinder();
  for (const create of [construct, builder.build.bind(builder), binder.bind.bind(binder)]) {
    assert.throws(() => create(root, resources, new Interactions()), { name: 'TypeError', message: /remove the Interactions argument/ });
    assert.throws(() => create(root, resources, new HostWithOptions()), { name: 'TypeError', message: /remove the Interactions argument/ });
    assert.throws(() => create(root, resources, new Interactions(), {}), { name: 'TypeError', message: /pass any options directly after resources/ });
    assert.throws(() => create(root, resources, {}, undefined), TypeError);
    assert.throws(() => create(root, resources, undefined, { validate: () => assert.fail('lost validation') }), /resources, options/);
    for (const invalid of [null, [], 'options', 1, false]) assert.throws(() => create(root, resources, invalid), TypeError);
  }
});

test('removing the former host argument reuses a channel already supplied through Resources and keeps optional validation', async () => {
  const offer = resource();
  const interactions = new Interactions().register(contract, { send: (request) => request });
  const resources = new Resources().register(offer, interactions.bind(contract));
  let validations = 0;
  const options = {
    validate() {
      validations++;
    },
  };
  for (const args of [[], [options]]) {
    const root = scene(offer);
    assert.throws(() => new Runner(root, resources, interactions, ...args), TypeError);
    const runner = new Runner(root, resources, ...args).build();
    assert.equal((await runner.run({ text: 'existing channel' })).result.feedback.payload.text, 'existing channel');
  }
  assert.equal(validations, 1);
  await interactions.settled();
  interactions.close();
});

test('inherited validation and hook methods retain their receiver through each construction entry', async () => {
  class Options {
    calls = [];
    constructor(root) {
      this.root = root;
    }
    validate() {
      this.calls.push('validate');
    }
    get hooks() {
      return [
        callableHooks(this.root, {
          validate: () => {
            this.calls.push('hook');
          },
        }),
      ];
    }
  }
  const resources = new Resources();
  for (const entry of ['runner', 'builder', 'binder']) {
    const root = new Scene({ run: () => null });
    const options = new Options(root);
    if (entry === 'runner') {
      await new Runner(root, resources, options).build().run(null);
    } else {
      const calls = entry === 'builder' ? callableConstruction(new CallableBuilder().build(root, resources, options)).calls : new CallableBinder().bind(root, resources, options).calls;
      calls.begin({}).prepare(root, null, false);
    }
    assert.deepEqual(options.calls, ['validate', 'hook']);
  }
});

test('construction accepts empty instances and callable options with an ordinary bind method', async () => {
  class EmptyOptions {}

  const resources = new Resources();
  let validations = 0;
  const callable = Object.assign(() => assert.fail('configuration must not be called'), {
    validate() {
      assert.equal(this, callable);
      validations++;
    },
  });
  for (const options of [new EmptyOptions(), callable]) {
    const scene = () => new Scene({ run: () => null });
    assert.equal(await new Runner(scene(), resources, options).build().run(null), null);
    const root = scene();
    callableConstruction(new CallableBuilder().build(root, resources, options))
      .calls.begin({})
      .prepare(root, null, false);
    const bound = scene();
    new CallableBinder().bind(bound, resources, options).calls.begin({}).prepare(bound, null, false);
  }
  assert.equal(validations, 3);
});

test('Runner reads checkpoint configuration supplied by a prototype getter', () => {
  const store = new MemoryCheckpointStore();
  class Options {
    get checkpoints() {
      return { store };
    }
  }
  const runner = new Runner(new Scene({ run: () => null }), new Resources(), new Options());
  assert.equal(runner.checkpointStore, store);
});

test('unused interaction resource registration does not require an interaction host', async () => {
  const resources = new Resources().registerBinding(resource(), () => assert.fail('unused binding'));
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
  const runner = new Runner(
    scene(offer),
    new Resources().registerBinding(offer, () => interactions.bind(contract)),
  ).build();
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
  const runner = new Runner(
    root,
    new Resources().registerBinding(offer, () => interactions.bind(contract)),
  ).build();
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
  const supplies = (host) => new Resources().registerBinding(offer, () => host.bind(contract));
  const original = new Interactions().register(contract, { send: (request) => request, persistence });
  const first = await new Runner(scene(offer), supplies(original)).build().run({ text: 'retained' });
  await original.settled();
  original.close();
  const restored = new Interactions().register(contract, { send: () => assert.fail('read resent request'), persistence });
  const second = await new Runner(scene(offer), supplies(restored)).build().run({ ref: first.ref, read: true });
  assert.equal(second.result.feedback.payload.text, 'retained');
  assert.equal(stored.size, 1);
});
