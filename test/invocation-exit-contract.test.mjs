import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { Invocation, InvocationCancelled, InvocationContext } from '@capix/invocation';
import { Resource, ResourceAccessClosed, ResourceOffer } from '@capix/resources';
import { Node, Resources, Runner, Scene, checkpointPoint } from '@capix/server-runtime';

const codec = { encode: (value) => value, decode: (value) => value };
const probe = new ResourceOffer({
  methods: {
    read: (events) => {
      events.push('resource-read');
      return 'material';
    },
  },
});
const deps = { probe: probe.request() };

/** Resume from an actual saved boundary in a fresh Store, never from a live call. */
async function entry(mode, run, events, output) {
  function scene(capture = false) {
    const child = new Node({ run: () => 'child' });
    const point = checkpointPoint()({ name: 'ready', state: codec, references: {}, resume: { deps, uses: [child], run } });
    return new Scene({
      deps,
      ...(output ? { output } : {}),
      checkpoint: { key: 'test.exit-contract', version: 1, input: codec, output: codec, points: [point] },
      run: capture
        ? (work) => {
            work.checkpoint({ point, state: null });
            return 'seed';
          }
        : run,
    }).add({ child });
  }
  const resources = new Resources().register(new Resource(events), probe);
  if (mode === 'normal') {
    const runner = new Runner(scene(), resources).build();
    return { runner, start: () => runner.run(null) };
  }
  const journal = new (class extends MemoryCheckpointStore {
    image;
    save(image, revision) {
      const head = super.save(image, revision);
      this.image ??= head.image;
      return head;
    }
  })();
  await new Runner(scene(true), resources, undefined, { checkpoints: { store: journal } }).build().run(null);
  const store = new MemoryCheckpointStore();
  const saved = store.save(structuredClone(journal.image), 0);
  const runner = new Runner(scene(), resources, undefined, { checkpoints: { store } }).build();
  return { runner, start: () => runner.resume(saved.image.frame.owner.contextId) };
}

for (const mode of ['normal', 'resume']) {
  for (const bodyResult of ['succeeded', 'failed']) {
    test(`${mode} body ${bodyResult}: started reception retains its resource window until callback completion`, async () => {
      const gate = Promise.withResolvers();
      const receiving = Promise.withResolvers();
      const events = [];
      const failure = new Error('body failed');
      let retained;
      let reception;
      const harness = await entry(
        mode,
        (work) => {
          retained = work.resources.probe;
          reception = work.children.child.invoke(null, {
            result: {
              succeeded: async () => {
                events.push('receiving');
                receiving.resolve();
                await gate.promise;
                const value = await retained.read();
                events.push('received');
                return value;
              },
            },
          });
          events.push('body-exit');
          if (bodyResult === 'failed') throw failure;
          return 'parent';
        },
        events,
      );
      let settled = false;
      const pending = harness.start().then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
      await receiving.promise;
      assert.deepEqual(events, ['body-exit', 'receiving']);
      assert.equal(harness.runner.isRunning, true);
      assert.equal(settled, false);
      gate.resolve();
      assert.equal(await reception, 'material');
      const result = await pending;
      if (bodyResult === 'failed') assert.equal(result.error, failure);
      else assert.equal(result.value, 'parent');
      assert.deepEqual(events, ['body-exit', 'receiving', 'resource-read', 'received']);
      assert.equal(harness.runner.isRunning, false);
      await assert.rejects(retained.read(), ResourceAccessClosed);
      assert.equal(events.filter((event) => event === 'resource-read').length, 1);
    });
  }

  test(`${mode} seals output before the outstanding child receiver completes`, async () => {
    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const events = [];
    let writer;
    let reception;
    const harness = await entry(
      mode,
      (work) => {
        writer = work.output;
        writer.emit('body-preview');
        reception = work.children.child.invoke(null, {
          result: {
            succeeded: async () => {
              entered.resolve();
              await gate.promise;
              return 'accepted';
            },
          },
        });
        return 'parent';
      },
      [],
      { result: (value) => value, delta: (value) => value },
    );
    harness.runner.output.subscribe({
      receive: (event) => {
        events.push(event.kind);
      },
    });
    const pending = harness.start();
    await entered.promise;
    assert.deepEqual(events, ['started', 'delta', 'sealed']);
    assert.throws(() => writer.emit('late-preview'), { code: 'OUTPUT_CLOSED' });
    assert.equal(harness.runner.isRunning, true);
    gate.resolve();
    assert.equal(await reception, 'accepted');
    assert.equal(await pending, 'parent');
    assert.deepEqual(events, ['started', 'delta', 'sealed', 'completed']);
    assert.equal(harness.runner.isRunning, false);
  });

  test(`${mode} seals in the body promise continuation before a later queued microtask`, async () => {
    let late;
    const events = [];
    const harness = await entry(
      mode,
      (work) => {
        const done = Promise.resolve('parent');
        void done.then(() =>
          queueMicrotask(() => {
            try {
              work.output.emit('too late');
            } catch (error) {
              late = error.code;
            }
          }),
        );
        return done;
      },
      [],
      { result: (value) => value, delta: (value) => value },
    );
    harness.runner.output.subscribe({
      receive: (event) => {
        events.push(event.kind);
      },
    });
    assert.equal(await harness.start(), 'parent');
    assert.equal(late, 'OUTPUT_CLOSED');
    assert.deepEqual(events, ['started', 'sealed', 'completed']);
  });
}

test('cancellation blocks reception resource use without releasing a callback that is still executing', async () => {
  const entered = Promise.withResolvers();
  const checked = Promise.withResolvers();
  const check = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  let reception;
  let signal;
  const harness = await entry(
    'normal',
    (work) => {
      signal = work.signal;
      const retained = work.resources.probe;
      reception = work.children.child.invoke(null, {
        result: {
          succeeded: async () => {
            entered.resolve();
            await check.promise;
            await assert.rejects(retained.read(), InvocationCancelled);
            checked.resolve();
            await finish.promise;
            return 'callback done';
          },
        },
      });
      // The rejection is still owned by the parent; observing it avoids a detached test rejection.
      void reception.catch(() => undefined);
      return 'parent';
    },
    events,
  );
  let settled = false;
  const pending = harness.start().then(
    () => assert.fail('cancelled call must not succeed'),
    (error) => {
      settled = true;
      return error;
    },
  );
  await entered.promise;
  assert.equal(harness.runner.cancel('test stop'), true);
  assert.equal(signal.aborted, true);
  check.resolve();
  await checked.promise;
  assert.equal(settled, false);
  assert.equal(harness.runner.isRunning, true);
  assert.deepEqual(events, []);
  finish.resolve();
  assert.ok((await pending) instanceof InvocationCancelled);
  assert.equal(harness.runner.isRunning, false);
});

test('low-level Invocation drains an explicitly started reception before becoming terminal', async () => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  let child;
  let reception;
  const parent = new Invocation({
    context: new InvocationContext(null),
    signal: new AbortController().signal,
    work: {
      async execute(_context, invocation) {
        child = new Invocation({ context: new InvocationContext(null), signal: new AbortController().signal, parent: { invocation }, work: { execute: () => 'child' } });
        await child.run();
        reception = invocation.children.get(child).accept(async () => {
          entered.resolve();
          await finish.promise;
          events.push('accepted');
          return 'accepted';
        });
        events.push('body-exit');
        return 'parent';
      },
    },
  });
  let settled = false;
  const pending = parent.run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  assert.equal(settled, false);
  assert.equal(parent.context.status, 'running');
  assert.equal(parent.children.get(child).reception.status, 'receiving');
  finish.resolve();
  assert.equal(await reception, 'accepted');
  assert.equal(await pending, 'parent');
  assert.deepEqual(events, ['body-exit', 'accepted']);
  assert.equal(parent.context.status, 'succeeded');
  assert.equal(parent.children.get(child).reception.status, 'accepted');
});

test('low-level Invocation joins a started child but does not run an unstarted relationship', async () => {
  const childEntered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let started;
  let dormant;
  const parent = new Invocation({
    context: new InvocationContext(null),
    signal: new AbortController().signal,
    work: {
      execute(_context, invocation) {
        started = new Invocation({
          context: new InvocationContext(null),
          signal: new AbortController().signal,
          parent: { invocation },
          work: {
            async execute() {
              childEntered.resolve();
              await finish.promise;
              return 'child';
            },
          },
        });
        dormant = new Invocation({ context: new InvocationContext(null), signal: new AbortController().signal, parent: { invocation }, work: { execute: () => assert.fail('unstarted child must not execute') } });
        void started.run();
        return 'parent';
      },
    },
  });
  let settled = false;
  const pending = parent.run().then((value) => {
    settled = true;
    return value;
  });
  await childEntered.promise;
  assert.equal(settled, false);
  assert.equal(parent.context.status, 'running');
  finish.resolve();
  assert.equal(await pending, 'parent');
  assert.equal(started.context.status, 'succeeded');
  assert.equal(parent.children.get(started).reception.status, 'pending');
  assert.equal(parent.children.get(dormant).returned, undefined);
  assert.equal(parent.context.status, 'succeeded');
});
