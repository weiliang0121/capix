import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, Node, Resources, Runner, checkpointPoint, childReference, ExceptionContract } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { ResourceOffer } from '@capix/resources';
import { Transcript, TranscriptResource } from '@capix/transcript';

const codec = { encode: structuredClone, decode: structuredClone };

function readable(name, options) {
  return new ResourceOffer({ name, expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }), timing: 'access', ...options });
}

test('Resources supplies a shared entity through independent call endpoints, without capturing at build', async () => {
  const entity = { value: 'first' };
  let captures = 0;
  let dormantCaptures = 0;
  const endpoints = [];
  const value = new ResourceOffer({
    name: 'runner.fixed',
    expose: (snapshot, activity) => {
      const endpoint = { read: () => activity.runSync('read', {}, () => snapshot) };
      endpoints.push(endpoint);
      return endpoint;
    },
    timing: 'access',
    capture(source) {
      captures++;
      return source.value;
    },
  });
  const dormant = readable('runner.dormant', {
    capture() {
      dormantCaptures++;
      return 'unused';
    },
  });
  const child = new Node({ deps: { value: value.request() }, run: (work) => work.resources.value.read() });
  const unused = new Node({ deps: { value: dormant.request() }, run: () => assert.fail('unselected member must not execute') });
  const scene = new Scene();
  scene.add(child, unused);
  Object.assign(scene, {
    deps: {},
    run: async function (work) {
      assert.deepEqual(Object.keys(work.resources), [], 'subtree supply must not grant parent access');
      const calls = [work.children.create(child, null), work.children.create(child, null)];
      await Promise.all(calls.map((call) => call.run()));
      return Promise.all(calls.map((call) => call.accept()));
    },
  });
  const resources = new Resources();
  resources.register(value, entity);
  resources.register(dormant, null);
  const runner = new Runner(scene, resources);
  assert.equal(runner.build(), runner);
  assert.equal(captures, 0);
  assert.equal(endpoints.length, 0);
  assert.deepEqual(await runner.run(null), ['first', 'first']);
  entity.value = 'second';
  assert.deepEqual(await runner.run(null), ['second', 'second']);
  assert.equal(captures, 2, 'capture is fixed within one supply and renewed for a new run');
  assert.equal(dormantCaptures, 0);
  assert.equal(new Set(endpoints).size, 4, 'shared supply does not share call endpoints');
  for (const endpoint of endpoints) assert.throws(() => endpoint.read(), /ended|running|closed/);
});

test('one explicit capture supplies several offers coherently and leaves sibling supply untouched', async () => {
  const left = readable('runner.capture.left');
  const right = readable('runner.capture.right');
  let captured = 0;
  let selected = 0;
  const pair = () => new Node({ deps: { left: left.request(), right: right.request() }, run: (work) => [work.resources.left.read(), work.resources.right.read()] });
  const leaf = pair();
  const sibling = pair();
  const group = new Group();
  group.add(leaf);
  Object.assign(group, {
    deps: {},
    run: async function (work) {
      const first = work.children.create(leaf, null);
      const second = work.children.create(leaf, null);
      await Promise.all([first.run(), second.run()]);
      return Promise.all([first.accept(), second.accept()]);
    },
  });
  const scene = new Scene();
  scene.add(group, sibling);
  Object.assign(scene, {
    deps: {},
    run: async function (work) {
      const scoped = work.children.create(group, work.input);
      const normal = work.children.create(sibling, null);
      await Promise.all([scoped.run(), normal.run()]);
      return [await scoped.accept(), await normal.accept()];
    },
  });
  const resources = new Resources();
  resources.register(left, 'global-left');
  resources.register(right, 'global-right');
  resources
    .capture(group, (input, options) => {
      captured++;
      return Object.freeze({ left: `${input}:${options.revision}`, right: captured });
    })
    .register(left, (snapshot) => {
      selected++;
      return snapshot.left;
    })
    .register(right, (snapshot) => snapshot.right);
  const runner = new Runner(scene, resources).build();
  assert.equal(captured, 0);
  assert.deepEqual(await runner.run('one', { revision: 7 }), [
    [
      ['one:7', 1],
      ['one:7', 1],
    ],
    ['global-left', 'global-right'],
  ]);
  assert.deepEqual(await runner.run('two', { revision: 8 }), [
    [
      ['two:8', 2],
      ['two:8', 2],
    ],
    ['global-left', 'global-right'],
  ]);
  assert.equal(captured, 2);
  assert.equal(selected, 2);
});

test('a nested partial capture inherits the actual narrowed ancestor supply', async () => {
  const files = readable('runner.scope.files', {
    capture: (value) => Object.freeze([...value]),
    refine(value, selection) {
      if (selection.some((item) => !value.includes(item))) throw new Error('Cannot widen file scope');
      return Object.freeze([...selection]);
    },
  });
  const tag = readable('runner.scope.tag');
  const leaf = new Node({ deps: { files: files.request(), tag: tag.request() }, run: (work) => ({ files: work.resources.files.read(), tag: work.resources.tag.read() }) });
  const group = new Group();
  group.add(leaf);
  Object.assign(group, {
    deps: {},
    run: async function (work) {
      assert.deepEqual(Object.keys(work.resources), []);
      const call = work.children.create(leaf, work.input[0]);
      await call.run();
      return call.accept();
    },
  });
  const scene = new Scene();
  scene.add(group);
  Object.assign(scene, {
    deps: {},
    run: async function (work) {
      const calls = work.input.map((selection) => work.children.create(group, selection));
      await Promise.all(calls.map((call) => call.run()));
      return Promise.all(calls.map((call) => call.accept()));
    },
  });
  const resources = new Resources();
  resources.register(files, ['a', 'b']);
  resources.register(tag, 'global');
  resources.refine(
    group,
    files.refine((selection) => selection),
  );
  resources.capture(leaf, (input) => input).register(tag, (input) => `scoped:${input}`);
  const runner = new Runner(scene, resources).build();
  assert.deepEqual(await runner.run([['a'], ['b']]), [
    { files: ['a'], tag: 'scoped:a' },
    { files: ['b'], tag: 'scoped:b' },
  ]);
  await assert.rejects(runner.run([['outside']]), /Cannot widen file scope/);
  assert.deepEqual(await runner.run([['a']]), [{ files: ['a'], tag: 'scoped:a' }], 'failed refinement releases the root entry');
});

test('multiple Runners share a registry but keep capture scope, options and busy state independent', async () => {
  const value = readable('runner.shared');
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const make = (wait) =>
    new Scene({
      deps: { value: value.request() },
      async run(work) {
        const endpoint = work.resources.value;
        if (wait) {
          entered.resolve();
          await gate.promise;
        }
        return endpoint.read();
      },
    });
  const firstScene = make(true);
  const secondScene = make(false);
  const resources = new Resources();
  resources.capture(firstScene, (input, options) => `${input}:${options.suffix}`).register(value, (snapshot) => snapshot);
  resources.capture(secondScene, (input, options) => `${options.suffix}:${input}`).register(value, (snapshot) => snapshot);
  const first = new Runner(firstScene, resources).build();
  const second = new Runner(secondScene, resources).build();
  const pending = first.run('first', { suffix: 'one' });
  await entered.promise;
  await assert.rejects(first.run('duplicate', { suffix: 'wrong' }), (error) => error.code === 'RUNTIME_BUSY');
  assert.equal(await second.run('second', { suffix: 'two' }), 'two:second');
  gate.resolve();
  assert.equal(await pending, 'first:one');
});

test('a built Runner uses fixed registrations while later scope registration can serve a new Runner', async () => {
  const value = readable('runner.registration-snapshot');
  const originalScene = new Scene({ deps: { value: value.request() }, run: (work) => work.resources.value.read() });
  const nextScene = new Scene({ deps: { value: value.request() }, run: (work) => work.resources.value.read() });
  const resources = new Resources();
  resources.register(value, 'fixed');
  const original = new Runner(originalScene, resources).build();
  resources.capture(originalScene, () => 'too late').register(value, (snapshot) => snapshot);
  resources.capture(nextScene, () => 'next').register(value, (snapshot) => snapshot);
  assert.equal(await original.run(null), 'fixed');
  const next = new Runner(nextScene, resources).build();
  assert.equal(await next.run(null), 'next');
});

test('registered resource capture keeps its method while preserving the host receiver state', async () => {
  const policy = {
    name: 'runner.fixed-capture-contract',
    prefix: 'initial',
    expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }),
    capture(value) {
      return `${this.prefix}:${value}`;
    },
  };
  const offer = new ResourceOffer(policy);
  const scene = new Scene({ deps: { value: offer.request() }, run: (work) => work.resources.value.read() });
  const resources = new Resources();
  resources.register(offer, 'entity');
  const runner = new Runner(scene, resources).build();
  policy.prefix = 'updated';
  policy.capture = () => 'replaced after build';
  assert.equal(await runner.run(null), 'updated:entity');
});

test('capture failure and capture callback reentry do not leak the Runner reservation', async () => {
  const value = readable('runner.capture-failure');
  const scene = new Scene({ deps: { value: value.request() }, run: (work) => work.resources.value.read() });
  const resources = new Resources();
  let runner;
  let nested;
  resources
    .capture(scene, (input) => {
      if (input === 'fail') throw new Error('capture failed');
      if (input === 'reenter') nested = assert.rejects(runner.run('nested'), (error) => error.code === 'RUNTIME_BUSY');
      return input;
    })
    .register(value, (snapshot) => snapshot);
  runner = new Runner(scene, resources).build();
  await assert.rejects(runner.run('fail'), /capture failed/);
  assert.equal(await runner.run('reenter'), 'reenter');
  await nested;
  assert.equal(await runner.run('next'), 'next');
});

test('cancellation during a child capture prevents child establishment and releases the root after exit', async () => {
  const value = readable('runner.capture-cancel');
  const controller = new AbortController();
  let executed = 0;
  const child = new Node({
    deps: { value: value.request() },
    run(work) {
      executed++;
      return work.resources.value.read();
    },
  });
  const scene = new Scene().add(child);
  Object.assign(scene, {
    deps: {},
    run: async function (work) {
      const call = work.children.create(child, work.input);
      await call.run();
      return call.accept();
    },
  });
  const resources = new Resources();
  resources
    .capture(child, (input) => {
      if (input === 'cancel') controller.abort();
      return input;
    })
    .register(value, (snapshot) => snapshot);
  const runner = new Runner(scene, resources).build();
  await assert.rejects(runner.run('cancel', { signal: controller.signal }), (error) => error.code === 'INVOCATION_CANCELLED');
  assert.equal(executed, 0);
  assert.equal(runner.isRunning, false);
  assert.equal(await runner.run('next'), 'next');
  assert.equal(executed, 1);
});

test('scope capture and resource selectors reject asynchronous construction', async () => {
  for (const boundary of ['capture', 'select']) {
    const value = readable(`runner.sync.${boundary}`);
    const scene = new Scene({ deps: { value: value.request() }, run: (work) => work.resources.value.read() });
    const resources = new Resources();
    resources.capture(scene, () => (boundary === 'capture' ? Promise.resolve('unexpected') : 'snapshot')).register(value, (snapshot) => (boundary === 'select' ? Promise.resolve(snapshot) : snapshot));
    const runner = new Runner(scene, resources).build();
    await assert.rejects(runner.run(null), /synchronous|thenable|Promise|async/i, boundary);
  }
});

test('missing resource failure does not lock the scene and unused registrations stay irrelevant', async () => {
  const value = readable('runner.missing');
  const scene = new Scene({ deps: { value: value.request() }, run: (work) => work.resources.value.read() });
  const resources = new Resources();
  const runner = new Runner(scene, resources);
  assert.throws(() => runner.build(), /resource|supply|register|provider/i);
  resources.register(value, 'corrected');
  const unused = readable('runner.unused');
  resources.register(unused, 'not required');
  assert.equal(runner.build(), runner);
  assert.equal(await runner.run(null), 'corrected');
  assert.throws(() => runner.build(), /built|build|configuration/i);
});

test('resource registration checks exact identity and duplicate supply while allowing equal descriptive names', async () => {
  const first = readable('runner.same-name');
  const second = readable('runner.same-name');
  const resources = new Resources();
  resources.register(first, 'one');
  assert.throws(() => resources.register(first, 'duplicate'), /duplicate|registered/i);
  const scene = new Scene({ deps: { first: first.request(), second: second.request() }, run: (work) => [work.resources.first.read(), work.resources.second.read()] });
  assert.throws(() => new Runner(scene, resources).build(), /resource|supply|register|provider/i);
  resources.register(second, 'two');
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await new Runner(scene, resources).build().run(null), ['one', 'two']);
  assert.throws(() => resources.capture({}, () => null), /callable|structure|Scene|Group|Node/i);
});

test('operation fallback keeps this call resources active and closes them on exit', async () => {
  let captures = 0;
  const endpoints = [];
  const offer = new ResourceOffer({
    name: 'runner.phase',
    expose(value, activity) {
      const endpoint = { read: () => activity.runSync('read', {}, () => value) };
      endpoints.push(endpoint);
      return endpoint;
    },
  });
  const failed = new Node({
    run() {
      throw new Error('source unavailable');
    },
  });
  const scene = new Scene({
    deps: { value: offer.request() },
    async run(work) {
      assert.equal(work.resources.value.read(), 'fixed');
      return work.children.invoke(failed, null, {
        result: {
          failed() {
            return work.resources.value.read();
          },
        },
      });
    },
  }).add(failed);
  const resources = new Resources();
  resources
    .capture(scene, () => {
      captures++;
      return 'fixed';
    })
    .register(offer, (snapshot) => snapshot);
  assert.equal(await new Runner(scene, resources).build().run('initial'), 'fixed');
  assert.equal(captures, 1);
  assert.equal(endpoints.length, 1);
  for (const endpoint of endpoints) assert.throws(() => endpoint.read(), /ended|running|closed|inactive/);
});

test('fixed content writes still require actual parent reception and retain exact child provenance', async () => {
  const transcript = new Transcript();
  const child = new Node({ run: (work) => `answer:${work.input}` });
  const scene = new Scene();
  scene.add(child);
  Object.assign(scene, {
    deps: { messages: TranscriptResource.append.request() },
    run: async function (work) {
      const call = work.children.create(child, work.input);
      await call.run();
      return call.accept((content) => {
        const first = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
        assert.equal(work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] }), first);
        return first;
      });
    },
  });
  const resources = new Resources();
  resources.register(TranscriptResource.append, transcript);
  const runner = new Runner(scene, resources).build();
  assert.equal((await runner.run('one')).start, 0);
  assert.equal((await runner.run('two')).start, 1);
  const appends = transcript.exportState().appends;
  assert.equal(appends.length, 2);
  assert.notEqual(appends[0].request.operation.parentContextId, appends[1].request.operation.parentContextId);
  assert.notEqual(appends[0].request.operation.childContextId, appends[1].request.operation.childContextId);
  for (const append of appends) assert.notEqual(append.request.operation.parentContextId, append.request.operation.childContextId);

  const invalid = new Scene({
    deps: { messages: TranscriptResource.append.request() },
    run(work) {
      assert.throws(
        () => work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: 'unaccepted' }] }),
        (error) => error.name === 'ResourcePortError' && /active direct-child reception/.test(error.cause?.message),
      );
      return 'caught';
    },
  });
  await assert.rejects(new Runner(invalid, resources).build().run(null), (error) => error.name === 'ResourcePortError' && /active direct-child reception/.test(error.cause?.message));
  assert.equal(transcript.length, 2, 'catching an access fault does not turn it into a valid write');
});

test('Runner restoration opens fresh resource endpoints and preserves fixed input and caller-supplied snapshot', async () => {
  const snapshot = readable('runner.restore.snapshot');
  const endpoints = [];
  let normal = 0;
  let resumed = 0;
  let saved;
  const build = (store) => {
    const point = checkpointPoint()({
      name: 'prepared',
      state: codec,
      references: {},
      resume: {
        deps: { snapshot: snapshot.request() },
        run(work, state) {
          resumed++;
          endpoints.push(work.resources.snapshot);
          assert.equal(work.input, state.input);
          assert.equal(work.resources.snapshot.read(), state.captured);
          return `${state.input}:${state.captured}:resumed`;
        },
      },
    });
    const scene = new Scene({
      checkpoint: { key: 'runner.restore', version: 1, input: codec, output: codec, points: [point] },
      deps: { snapshot: snapshot.request() },
      run(work) {
        normal++;
        endpoints.push(work.resources.snapshot);
        work.checkpoint({ point: point, state: { input: work.input, captured: work.resources.snapshot.read() }, refs: {} });
        return 'normal';
      },
    });
    const resources = new Resources();
    resources.capture(scene, (_input, options) => options.snapshot).register(snapshot, (value) => value);
    return new Runner(scene, resources, undefined, { checkpoints: { store } }).build();
  };
  class Capture extends MemoryCheckpointStore {
    save(image, revision) {
      saved = image;
      return super.save(image, revision);
    }
  }
  assert.equal(await build(new Capture()).run('original', { snapshot: 'fixed' }), 'normal');
  const store = new MemoryCheckpointStore();
  store.save(saved, 0);
  assert.equal(await build(store).resume(saved.frame.owner.contextId, { snapshot: 'fixed' }), 'original:fixed:resumed');
  assert.equal(normal, 1);
  assert.equal(resumed, 1);
  assert.notEqual(endpoints[0], endpoints[1]);
  for (const endpoint of endpoints) assert.throws(() => endpoint.read(), /ended|running|closed|inactive/);
});

test('a saved returned child is accepted through new resource access without rerunning or duplicating its fixed effect', async () => {
  const transcript = new Transcript();
  let childRuns = 0;
  let saved;
  const build = (store) => {
    const answer = new Node({
      run: () => {
        childRuns++;
        return 'durable answer';
      },
    });
    const receive = (work, call) => call.accept((content) => work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] }));
    const point = checkpointPoint()({
      name: 'returned',
      state: codec,
      references: { answer: childReference(answer) },
      resume: {
        deps: { messages: TranscriptResource.append.request() },
        run(work, _state, refs) {
          return receive(work, work.children.open(refs.answer));
        },
      },
    });
    const scene = new Scene({
      checkpoint: { key: 'runner.fixed-reception', version: 1, input: codec, output: codec, points: [point] },
      deps: { messages: TranscriptResource.append.request() },
      async run(work) {
        const call = work.children.create(answer, null);
        await call.run();
        work.checkpoint({ point: point, state: null, refs: { answer: call.ref } });
        return receive(work, call);
      },
    });
    scene.add(answer);
    const resources = new Resources();
    resources.register(TranscriptResource.append, transcript);
    return new Runner(scene, resources, undefined, { checkpoints: { store } }).build();
  };
  class Capture extends MemoryCheckpointStore {
    save(image, revision) {
      saved = image;
      return super.save(image, revision);
    }
  }
  const original = await build(new Capture()).run(null);
  assert.equal(transcript.length, 1);
  assert.equal(saved.frame.children[0].state.reception.kind, 'pending');
  const store = new MemoryCheckpointStore();
  store.save(saved, 0);
  const result = await build(store).resume(saved.frame.owner.contextId);
  assert.deepEqual(result, original);
  assert.equal(childRuns, 1);
  assert.equal(transcript.length, 1);
});
