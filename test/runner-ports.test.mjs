import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { isInvocationCancelled } from '@weiliang0121/capix-invocation';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { Runner, Resources, Scene, Node, callableHooks } from '@weiliang0121/capix-runtime';

const output = { result: (value) => value, delta: (value) => value };
const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function collect(events) {
  return { receive: (event) => void events.push(event) };
}

test('Runner output subscriptions span independent runs and coexist with exact scene hooks', async () => {
  const events = [];
  const hookEvents = [];
  const scene = new Scene({
    output,
    run(work) {
      work.output.emit(`${work.input.label}:preview`);
      return work.input;
    },
  });
  const runner = new Runner(scene, new Resources(), undefined, { hooks: [callableHooks(scene, { output: () => collect(hookEvents) })] }).build();
  const unsubscribe = runner.output.subscribe(collect(events));
  const first = { label: 'first' };
  const second = { label: 'second' };

  assert.deepEqual(await runner.run(first), first);
  assert.deepEqual(await runner.run(second), second);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['started', 'delta', 'sealed', 'completed', 'started', 'delta', 'sealed', 'completed'],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 1, 2, 3, 4],
  );
  assert.notEqual(events[0].contextId, events[4].contextId);
  assert.ok(events.slice(0, 4).every((event) => event.contextId === events[0].contextId));
  assert.ok(events.slice(4).every((event) => event.contextId === events[4].contextId));
  assert.deepEqual(events[3].result, first);
  assert.deepEqual(events[7].result, second);
  assert.equal(events.length, hookEvents.length);
  assert.ok(
    events.every(({ entryId, ...event }, index) => {
      assert.equal(typeof entryId, 'string');
      assert.deepEqual(event, hookEvents[index]);
      return true;
    }),
  );
  unsubscribe();
  unsubscribe();
});

test('Runner publishes only the scene output; child deltas require explicit forwarding', async () => {
  const rootEvents = [];
  const childEvents = [];
  const child = new Node({
    output,
    run(work) {
      work.output.emit('child preview');
      return 'child answer';
    },
  });
  const scene = new Scene({ output }).add({ child });
  scene.run = (work) => work.children.child.invoke(work.input);
  const runner = new Runner(scene, new Resources(), undefined, { hooks: [callableHooks(child, { output: () => collect(childEvents) })] }).build();
  runner.output.subscribe(collect(rootEvents));

  assert.equal(await runner.run(null), 'child answer');
  assert.deepEqual(
    rootEvents.map((event) => event.kind),
    ['started', 'sealed', 'completed'],
  );
  assert.deepEqual(
    childEvents.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['child preview'],
  );
  assert.notEqual(rootEvents[0].contextId, childEvents[0].contextId);
});

test('unsubscribe is idempotent and late subscriptions receive only subsequent events', { timeout: 5000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const before = [];
  const after = [];
  const scene = new Scene({
    output,
    async run(work) {
      work.output.emit('early');
      entered.resolve();
      await release.promise;
      work.output.emit('late');
      return 'answer';
    },
  });
  const runner = new Runner(scene, new Resources()).build();
  const unsubscribe = runner.output.subscribe(collect(before));
  const running = runner.run(null);
  await entered.promise;
  unsubscribe();
  unsubscribe();
  runner.output.subscribe(collect(after));

  assert.equal(runner.isRunning, true);
  assert.deepEqual(after, [], 'subscription is not historical replay');
  release.resolve();
  assert.equal(await running, 'answer');
  assert.deepEqual(
    before.map((event) => event.kind),
    ['started', 'delta'],
  );
  assert.deepEqual(
    after.map((event) => event.kind),
    ['delta', 'sealed', 'completed'],
  );
  assert.deepEqual(
    after.map((event) => event.sequence),
    [3, 4, 5],
  );
  assert.equal(after[0].contextId, before[0].contextId);
});

test('a faulty subscription is removed without affecting other receivers or later runs', async () => {
  const events = [];
  let throws = 0;
  let reports = 0;
  let asynchronous = 0;
  const scene = new Scene({
    output,
    run(work) {
      work.output.emit('preview');
      return work.input;
    },
  });
  const runner = new Runner(scene, new Resources()).build();
  runner.output.subscribe({
    receive() {
      throws++;
      throw new Error('subscriber failed');
    },
    failed() {
      reports++;
      throw new Error('failure reporter failed');
    },
  });
  runner.output.subscribe({
    receive() {
      asynchronous++;
      return Promise.reject(new Error('subscriber must be synchronous'));
    },
  });
  runner.output.subscribe(collect(events));

  assert.equal(await runner.run('first'), 'first');
  assert.equal(await runner.run('second'), 'second');
  assert.equal(throws, 1);
  assert.equal(reports, 1);
  assert.equal(asynchronous, 1);
  assert.equal(events.filter((event) => event.kind === 'completed').length, 2);
});

test('output callbacks can unsubscribe themselves and cannot reenter the occupied Runner', async () => {
  const events = [];
  let duplicate;
  let unsubscribe;
  const runner = new Runner(new Scene({ output, run: (work) => work.input }), new Resources()).build();
  unsubscribe = runner.output.subscribe({
    receive(event) {
      events.push(event);
      unsubscribe();
      duplicate = assert.rejects(runner.run('nested'), { code: 'RUNTIME_BUSY' });
    },
  });

  assert.equal(await runner.run('outer'), 'outer');
  await duplicate;
  assert.deepEqual(
    events.map((event) => event.kind),
    ['started'],
  );
  assert.equal(await runner.run('next'), 'next');
  assert.equal(events.length, 1);
});

test('cancel retains occupancy until real work settles and does not cancel subsequent runs', { timeout: 5000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const events = [];
  const signals = [];
  const reason = new Error('stop current run');
  const external = new AbortController();
  const scene = new Scene({
    output,
    async run(work) {
      signals.push(work.signal);
      if (work.input === 'first') {
        entered.resolve();
        await release.promise;
      }
      return work.input;
    },
  });
  const runner = new Runner(scene, new Resources()).build();
  runner.output.subscribe(collect(events));
  assert.equal(runner.cancel(), false);
  const first = runner.run('first', { signal: external.signal });
  const rejected = assert.rejects(first);
  await entered.promise;

  await assert.rejects(runner.run('busy before cancel'), { code: 'RUNTIME_BUSY' });
  assert.equal(runner.cancel(reason), true);
  assert.equal(runner.cancel(), false);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[0].reason, reason);
  assert.equal(external.signal.aborted, false, 'Runner cancellation must not abort the host-owned signal');
  assert.equal(runner.isRunning, true, 'cancel requests termination; it does not release active work');
  await assert.rejects(runner.run('busy'), { code: 'RUNTIME_BUSY' });
  release.resolve();
  await rejected;
  assert.equal(runner.isRunning, false);
  assert.equal(
    events.some((event) => event.kind === 'completed'),
    false,
  );
  assert.equal(runner.cancel(), false);

  assert.equal(await runner.run('next'), 'next');
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1].aborted, false);
  assert.equal(events.at(-1).kind, 'completed');
  assert.equal(events.at(-1).result, 'next');
});

test('cancel from a started output callback prevents business work without disabling the subscription', async () => {
  let runs = 0;
  let requested = false;
  const events = [];
  const runner = new Runner(new Scene({ output, run: () => ++runs }), new Resources()).build();
  runner.output.subscribe({
    receive(event) {
      events.push(event);
      if (event.kind === 'started' && !requested) requested = runner.cancel();
    },
  });

  await assert.rejects(runner.run(null));
  assert.equal(requested, true);
  assert.equal(runs, 0);
  assert.equal(runner.isRunning, false);
  assert.equal(await runner.run(null), 1);
  assert.equal(events.filter((event) => event.kind === 'started').length, 2);
  assert.equal(events.filter((event) => event.kind === 'completed').length, 1);
});

test('external cancellation and pre-cancellation remain local to the corresponding run', { timeout: 5000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  const signals = [];
  const scene = new Scene({
    output,
    async run(work) {
      signals.push(work.signal);
      if (work.input === 'external') {
        entered.resolve();
        await release.promise;
      }
      return work.input;
    },
  });
  const runner = new Runner(scene, new Resources()).build();
  const active = runner.run('external', { signal: controller.signal });
  const rejected = assert.rejects(active);
  await entered.promise;
  controller.abort(new Error('external cancellation'));
  assert.equal(signals[0].aborted, true);
  assert.equal(runner.isRunning, true);
  release.resolve();
  await rejected;

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  await assert.rejects(runner.run('must not execute', { signal: alreadyCancelled.signal }));
  assert.equal(signals.length, 1);
  assert.equal(await runner.run('next'), 'next');
  assert.equal(signals[1].aborted, false);
});

test('a late external abort from a completed run cannot cancel a new run', { timeout: 5000 }, async () => {
  const external = new AbortController();
  const entered = deferred();
  const release = deferred();
  let currentSignal;
  const runner = new Runner(
    new Scene({
      output,
      async run(work) {
        if (work.input === 'second') {
          currentSignal = work.signal;
          entered.resolve();
          await release.promise;
        }
        return work.input;
      },
    }),
    new Resources(),
  ).build();

  assert.equal(await runner.run('first', { signal: external.signal }), 'first');
  const second = runner.run('second');
  await entered.promise;
  external.abort(new Error('late cancellation from previous caller'));
  assert.equal(currentSignal.aborted, false);
  assert.equal(runner.isRunning, true);
  release.resolve();
  assert.equal(await second, 'second');
});

test('a released observer can start the next run without losing that run cancellation control', { timeout: 5000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const signals = [];
  let second;
  let rejected;
  let released = 0;
  let runner;
  const scene = new Scene({
    output,
    async run(work) {
      signals.push(work.signal);
      if (work.input === 'second') {
        entered.resolve();
        await release.promise;
      }
      return work.input;
    },
  });
  runner = new Runner(scene, new Resources(), undefined, {
    observations: [
      {
        bindInvocation: () => ({ observe() {} }),
        bindDriver: () => ({
          observe(fact) {
            if (fact.kind === 'released' && ++released === 1) {
              second = runner.run('second');
              rejected = assert.rejects(second);
            }
          },
        }),
      },
    ],
  }).build();

  assert.equal(await runner.run('first'), 'first');
  await entered.promise;
  assert.equal(runner.isRunning, true);
  assert.equal(runner.cancel(), true);
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[0].aborted, false);
  release.resolve();
  await rejected;
  assert.equal(runner.isRunning, false);
});

test('Runner output subscriptions also receive restored root output while resume returns its own result', async () => {
  const store = new MemoryCheckpointStore();
  const contextId = 'runner-ports-restored';
  const point = {
    name: 'saved',
    state: codec,
    references: {},
    resume: {
      deps: {},
      run(work, state) {
        assert.equal(work.input, 'fixed input');
        work.output.emit('restored preview');
        return state.answer;
      },
    },
  };
  const scene = new Scene({
    output,
    run: (work) => work.input,
    checkpoint: { key: 'runner-ports', version: 1, input: codec, output: codec, points: [point] },
  });
  store.save(
    {
      id: 'runner-ports-image',
      formatVersion: 6,
      contract: { key: 'runner-ports', version: 1 },
      point: 'saved',
      frame: { owner: { contextId, kind: 'scene' }, round: 1, phase: 'execute', input: 'fixed input', currentInput: 'fixed input', nextChildOrder: 0, children: [] },
      state: { answer: 'restored answer' },
      references: {},
    },
    0,
  );
  const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build();
  const events = [];
  runner.output.subscribe(collect(events));

  assert.equal(await runner.resume(contextId), 'restored answer');
  assert.deepEqual(
    events.map((event) => event.kind),
    ['started', 'delta', 'sealed', 'completed'],
  );
  assert.ok(events.every((event) => event.contextId === contextId));
  assert.equal(events.at(-1).result, 'restored answer');
  assert.equal(await runner.run('new answer'), 'new answer');
  assert.notEqual(events.at(-1).contextId, contextId);
  assert.equal(events.at(-1).result, 'new answer');
});

test('external cancellation preserves the original signal identity even when an earlier listener reenters cancel', { timeout: 5000 }, async () => {
  const external = new AbortController();
  const entered = deferred();
  const release = deferred();
  const reason = new Error('external stop');
  let runner;
  let internalSignal;
  let reentered;
  external.signal.addEventListener(
    'abort',
    () => {
      reentered = runner.cancel(new Error('reentrant request'));
    },
    { once: true },
  );
  const scene = new Scene({
    async run(work) {
      internalSignal = work.signal;
      entered.resolve();
      await release.promise;
      return 'late';
    },
  });
  runner = new Runner(scene, new Resources()).build();
  const active = runner.run(null, { signal: external.signal });
  const rejected = assert.rejects(active, (error) => {
    assert.equal(isInvocationCancelled(error, external.signal), true);
    assert.equal(isInvocationCancelled(error, internalSignal), false);
    return true;
  });
  await entered.promise;
  external.abort(reason);
  assert.equal(reentered, false);
  assert.equal(internalSignal.reason, reason);
  release.resolve();
  await rejected;
  assert.equal(runner.isRunning, false);
});

test('Runner cancellation cannot be relabeled as external when an external abort follows it', { timeout: 5000 }, async () => {
  const external = new AbortController();
  const entered = deferred();
  const release = deferred();
  const reason = new Error('runner stop');
  let internalSignal;
  const runner = new Runner(
    new Scene({
      async run(work) {
        internalSignal = work.signal;
        work.signal.addEventListener('abort', () => external.abort(new Error('following external abort')), { once: true });
        entered.resolve();
        await release.promise;
        return 'late';
      },
    }),
    new Resources(),
  ).build();
  const active = runner.run(null, { signal: external.signal });
  const rejected = assert.rejects(active, (error) => {
    assert.equal(isInvocationCancelled(error, internalSignal), true);
    assert.equal(isInvocationCancelled(error, external.signal), false);
    return true;
  });
  await entered.promise;
  assert.equal(runner.cancel(reason), true);
  assert.equal(external.signal.aborted, true);
  assert.equal(internalSignal.reason, reason);
  release.resolve();
  await rejected;
  assert.equal(runner.isRunning, false);
});

for (const stage of ['acquired', 'validate', 'capture']) {
  test(`cancellation during ${stage} prevents business execution and releases entry`, async () => {
    let runner;
    let validations = 0;
    let captures = 0;
    let runs = 0;
    const offer = new ResourceOffer({ methods: { read: (value) => value } });
    const scene = new Scene({ deps: { value: offer.request() }, run: () => ++runs });
    const resources = new Resources();
    resources
      .capture(scene, () => {
        captures++;
        if (stage === 'capture') assert.equal(runner.cancel(), true);
        return 'captured';
      })
      .register(offer, (value) => value);
    runner = new Runner(scene, resources, undefined, {
      validate() {
        validations++;
        if (stage === 'validate') assert.equal(runner.cancel(), true);
      },
      observations: [
        {
          bindInvocation: () => ({ observe() {} }),
          bindDriver: () => ({
            observe(fact) {
              if (fact.kind === 'acquired' && stage === 'acquired') assert.equal(runner.cancel(), true);
            },
          }),
        },
      ],
    }).build();

    await assert.rejects(runner.run(null), { code: 'INVOCATION_CANCELLED' });
    assert.equal(runs, 0);
    assert.equal(runner.isRunning, false);
    assert.equal(runner.cancel(), false);
    if (stage === 'acquired') {
      assert.equal(validations, 0);
      assert.equal(captures, 0);
    }
    if (stage === 'validate') assert.equal(validations, 1);
    if (stage === 'capture') assert.equal(captures, 1);
  });
}

test('strict release failure stays aggregated with cancellation instead of being mapped to an external cancellation', { timeout: 5000 }, async () => {
  const external = new AbortController();
  const entered = deferred();
  const release = deferred();
  const observerFailure = new Error('release observation failed');
  let internalSignal;
  const scene = new Scene({
    async run(work) {
      internalSignal = work.signal;
      entered.resolve();
      await release.promise;
      return 'late';
    },
  });
  const runner = new Runner(scene, new Resources(), undefined, {
    observations: [
      {
        failure: 'propagate',
        bindInvocation: () => ({ observe() {} }),
        bindDriver: () => ({
          observe(fact) {
            if (fact.kind === 'released') throw observerFailure;
          },
        }),
      },
    ],
  }).build();
  const active = runner.run(null, { signal: external.signal });
  const rejected = assert.rejects(active, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(isInvocationCancelled(error, external.signal), false);
    assert.equal(isInvocationCancelled(error.errors[0], internalSignal), true);
    assert.equal(error.errors[1].cause, observerFailure);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  await entered.promise;
  external.abort();
  release.resolve();
  await rejected;
  assert.equal(runner.isRunning, false);
});

test('cancellation while binding an invocation observer prevents the formal started callback and business work', async () => {
  let runner;
  let bindings = 0;
  let started = 0;
  let runs = 0;
  const scene = new Scene({ run: () => ++runs });
  runner = new Runner(scene, new Resources(), undefined, {
    hooks: [
      callableHooks(scene, {
        started: () => () => {
          started++;
        },
      }),
    ],
    observations: [
      {
        bindInvocation() {
          if (++bindings === 1) assert.equal(runner.cancel(), true);
          return { observe() {} };
        },
      },
    ],
  }).build();

  await assert.rejects(runner.run(null), { code: 'INVOCATION_CANCELLED' });
  assert.equal(bindings, 1);
  assert.equal(started, 0);
  assert.equal(runs, 0);
  assert.equal(runner.isRunning, false);
  assert.equal(await runner.run(null), 1);
  assert.equal(started, 1);
});
