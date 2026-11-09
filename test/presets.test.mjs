import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sequence, Dynamic, Scene, Group, Node } from '@weiliang0121/capix-structure';
import { Runner, Resources, defineObservation, callableHooks } from '@weiliang0121/capix-runtime';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';

function install(preset, resources = new Resources(), options = {}) {
  const scene = new Scene().add({ preset });
  scene.run = (work) => work.children.preset.invoke(work.input);
  return new Runner(scene, resources, undefined, options).build();
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('Sequence is a Group whose accepted results feed the next step, with original input available', async () => {
  const seen = [];
  const read = new Node({
    run: (work) => {
      seen.push(work.input);
      return `read:${work.input}`;
    },
  });
  const translate = new Node({ run: (work) => work.input.toUpperCase() });
  const save = new Node({ run: (work) => work.input });
  const sequence = new Sequence([{ node: read, input: ({ input }) => input.source }, translate, { node: save, input: ({ input, previous }) => ({ path: input.destination, text: previous }) }]);
  assert.ok(sequence instanceof Group);
  assert.equal(sequence.kind, 'group');
  assert.deepEqual(sequence.members, [read, translate, save]);
  const runner = install(sequence);
  assert.deepEqual(await runner.run({ source: 'notes.md', destination: 'summary.md' }), { path: 'summary.md', text: 'READ:NOTES.MD' });
  assert.deepEqual(await runner.run({ source: 'next.md', destination: 'next-summary.md' }), { path: 'next-summary.md', text: 'READ:NEXT.MD' });
  assert.deepEqual(seen, ['notes.md', 'next.md']);
});

test('empty Sequence returns stable input; repeated steps share a member, never a call', async () => {
  const original = { value: 1 };
  assert.deepEqual(await install(new Sequence([])).run(original), original);
  const node = new Node({ run: (work) => work.input + 1 });
  const sequence = new Sequence([node, node]);
  const calls = [];
  const runner = install(sequence, new Resources(), {
    hooks: [
      callableHooks(node, {
        started: () => (_context, invocation) => {
          calls.push(invocation);
        },
      }),
    ],
  });
  assert.deepEqual(sequence.members, [node]);
  assert.equal(sequence.steps.length, 2);
  assert.equal(await runner.run(0), 2);
  assert.notEqual(calls[0].context.id, calls[1].context.id);
});

test('Sequence waits for result reception and forwards declared deltas through ordinary operations', async () => {
  const entered = deferred();
  const release = deferred();
  const emitted = [];
  let nextStarted = false;
  const node = new Node({
    output: { result: Number, delta: String },
    run: (work) => {
      work.output.emit('preview');
      return work.input;
    },
  });
  const after = new Node({
    run: (work) => {
      nextStarted = true;
      return work.input;
    },
  });
  const sequence = new Sequence([
    {
      node,
      delta: (value, scope) => emitted.push([value, scope.input]),
      result: {
        async succeeded(value, scope) {
          entered.resolve();
          await release.promise;
          return value + scope.previous;
        },
      },
    },
    after,
  ]);
  const pending = install(sequence).run(3);
  await entered.promise;
  assert.equal(nextStarted, false);
  assert.deepEqual(emitted, [['preview', 3]]);
  release.resolve();
  assert.equal(await pending, 6);
});

test('Sequence stops on unhandled failure and can continue only through explicit result handling', async () => {
  const failure = new Error('failed');
  let later = 0;
  const makeFailure = () =>
    new Node({
      run: () => {
        throw failure;
      },
    });
  const next = () =>
    new Node({
      run: (work) => {
        later++;
        return work.input;
      },
    });
  await assert.rejects(install(new Sequence([makeFailure(), next()])).run('input'), (error) => error === failure);
  assert.equal(later, 0);
  const handled = new Sequence([
    {
      node: makeFailure(),
      result: {
        failed: (error, scope) => {
          assert.equal(error, failure);
          return scope.input;
        },
      },
    },
    next(),
  ]);
  assert.equal(await install(handled).run('fallback'), 'fallback');
  assert.equal(later, 1);
});

test('Sequence reception errors do not reenter the same failed handler or retry a child', async () => {
  let childRuns = 0;
  let failedRuns = 0;
  const failure = new Error('reception failed');
  const node = new Node({ run: () => ++childRuns });
  const sequence = new Sequence([
    {
      node,
      result: {
        succeeded: () => {
          throw failure;
        },
        failed: () => ++failedRuns,
      },
    },
  ]);
  await assert.rejects(install(sequence).run(null), (error) => error === failure);
  assert.equal(childRuns, 1);
  assert.equal(failedRuns, 0);
});

test('Sequence does not mask protected observation failures through result.failed', async () => {
  let handled = false;
  const failure = new Error('observer failed');
  const node = new Node({ run: () => 'complete' });
  const observation = defineObservation(
    {
      deps: {},
      observe: (fact) => {
        if (fact.kind === 'finished') throw failure;
      },
    },
    { failure: 'propagate' },
  );
  const sequence = new Sequence([
    {
      node,
      result: {
        failed: () => {
          handled = true;
          return 'fallback';
        },
      },
    },
  ]);
  const runner = install(sequence, new Resources(), { observations: [{ bindInvocation: () => ({ observe() {} }), declarations: (structure) => (structure === node ? [observation] : []) }] });
  await assert.rejects(runner.run(null), (error) => error.code === 'OBSERVATION_FAILED');
  assert.equal(handled, false);
});

test('Sequence validates the whole constructor before claiming any member', async () => {
  const owner = new Group();
  const occupied = new Node({ run: () => 1 });
  owner.add(occupied);
  const free = new Node({ run: () => 2 });
  assert.throws(() => new Sequence([free, occupied]), /parent/);
  assert.throws(() => new Sequence([free, { node: new Node(), input: 123 }]), /functions/);
  assert.throws(() => new Sequence([free, { node: new Node(), result: 123 }]), /reception|object/);
  assert.throws(() => new Sequence([free, {}]), /Node|Group|node|member/i);
  assert.throws(() => new Sequence([free], { output: { result: 123 } }), /output/);
  const sequence = new Sequence([free]);
  assert.deepEqual(sequence.members, [free]);
  assert.equal(await install(sequence).run(null), 2);
  assert.throws(() => sequence.add(free), /locked/);
  assert.equal(sequence.step, undefined);
});

test('Sequence fixes the whole pipeline before aliases or external configuration can change its result', async () => {
  const original = new Node({
    output: { result: Number, delta: String },
    run(work) {
      work.output.emit('original');
      return work.input;
    },
  });
  const replacement = new Node({ run: () => 'wrong-result' });
  const received = [];
  const reception = { succeeded: (value) => value + 1 };
  const step = { node: original, key: 'original', input: ({ input }) => input + 1, delta: (value) => received.push(value), result: reception };
  const steps = [step];
  const sequence = new Sequence(steps);
  const earlierAlias = sequence;
  steps.push(replacement);
  steps[0] = replacement;
  step.node = replacement;
  step.key = 'replacement';
  step.input = () => 100;
  step.delta = () => received.push('wrong');
  reception.succeeded = () => 'wrong';
  step.result = { succeeded: () => 'also-wrong' };
  assert.deepEqual(sequence.steps, [{ node: original, key: 'original' }]);
  assert.equal(await install(earlierAlias).run(3), 5);
  assert.deepEqual(received, ['original']);
  assert.equal(earlierAlias, sequence);
  assert.equal(earlierAlias.step, undefined);
  assert.doesNotThrow(() => new Group().add(replacement), 'mutating the original array never registered another member');
});

test('Sequence keeps the declared output writer available and snapshots producer validators', async () => {
  const child = new Node({
    output: { result: Number, delta: String },
    run(work) {
      work.output.emit('preview');
      return work.input;
    },
  });
  const output = { result: Number, delta: String };
  const sequence = new Sequence([{ node: child, delta: (value, scope) => scope.output.emit(value) }], { output });
  assert.throws(() => {
    sequence.output = undefined;
  }, TypeError);
  assert.throws(() => {
    sequence.output.delta = undefined;
  }, TypeError);
  output.result = () => 'changed';
  output.delta = () => 'changed';
  const received = [];
  const scene = new Scene().add({ sequence });
  scene.run = (work) => work.children.sequence.invoke(work.input, { delta: (value) => received.push(value) });
  assert.equal(await new Runner(scene, new Resources()).build().run(3), 3);
  assert.deepEqual(received, ['preview']);
});

test('Dynamic decisions are ordinary children and the original input stays fixed', async () => {
  const board = new ResourceOffer({
    methods: {
      read: (origin) => origin.value,
      write: (origin, value) => {
        origin.value = value;
      },
    },
  });
  const action = new Node({
    deps: { board: board.request() },
    run: async (work) => {
      await work.resources.board.write(`${work.input}:done`);
      return 'action-result';
    },
  });
  const decision = new Node({
    deps: { board: board.request() },
    run: async (work) => {
      const value = await work.resources.board.read();
      return value === undefined ? { kind: 'call', option: 'action', input: work.input } : { kind: 'finish', value };
    },
  });
  const dynamic = new Dynamic({ options: { action }, decide: decision });
  const resources = new Resources();
  resources.capture(dynamic, () => ({ value: undefined })).register(board, (value) => value);
  const calls = [];
  const runner = install(dynamic, resources, {
    hooks: [decision, action].map((definition) =>
      callableHooks(definition, {
        started: () => (_context, call) => {
          calls.push([definition, call]);
        },
      }),
    ),
  });
  assert.equal(await runner.run('one'), 'one:done');
  assert.equal(await runner.run('two'), 'two:done');
  assert.equal(calls.filter(([node]) => node === decision).length, 4);
  assert.equal(calls.filter(([node]) => node === action).length, 2);
  assert.equal(new Set(calls.map(([, call]) => call.context.id)).size, 6);
  assert.deepEqual(dynamic.names, {}, 'candidate names do not install another set of named Work ports');
  assert.equal(dynamic.decisions, undefined);
});

test('Dynamic allows N action calls and one final finish decision', async () => {
  let actions = 0;
  let decisions = 0;
  const action = new Node({ run: () => ++actions });
  const dynamic = new Dynamic({
    maxSteps: 2,
    options: { action },
    decide: new Node({
      run: () => {
        decisions++;
        return actions === 2 ? { kind: 'finish', value: 'done' } : { kind: 'call', option: 'action', input: null };
      },
    }),
  });
  assert.equal(await install(dynamic).run(null), 'done');
  assert.equal(actions, 2);
  assert.equal(decisions, 3);
  let overflowActions = 0;
  const forever = new Dynamic({ maxSteps: 2, options: { action: new Node({ run: () => ++overflowActions }) }, decide: new Node({ run: () => ({ kind: 'call', option: 'action', input: null }) }) });
  await assert.rejects(install(forever).run(null), /exceeded 2 action steps/);
  assert.equal(overflowActions, 2);
  const immediate = new Dynamic({ maxSteps: 0, options: {}, decide: new Node({ run: () => ({ kind: 'finish', value: undefined }) }) });
  assert.equal(await install(immediate).run(null), undefined);
});

for (const invalid of [null, [], { kind: 'unknown' }, { kind: 'finish' }, { kind: 'call', option: 'action' }, { kind: 'call', option: 'missing', input: null }]) {
  test(`Dynamic rejects invalid decision ${JSON.stringify(invalid)} before action creation`, async () => {
    let effects = 0;
    const dynamic = new Dynamic({ options: { action: new Node({ run: () => ++effects }) }, decide: new Node({ run: () => invalid }) });
    await assert.rejects(install(dynamic).run(null), /Dynamic decision|not registered/);
    assert.equal(effects, 0);
  });
}

test('Dynamic does not retry failed actions or ask for another decision', async () => {
  const error = new Error('action failed');
  let decisions = 0;
  let effects = 0;
  const dynamic = new Dynamic({
    options: {
      action: new Node({
        run: () => {
          effects++;
          throw error;
        },
      }),
    },
    decide: new Node({
      run: () => {
        decisions++;
        return { kind: 'call', option: 'action', input: null };
      },
    }),
  });
  await assert.rejects(install(dynamic).run(null), (failure) => failure === error);
  assert.equal(decisions, 1);
  assert.equal(effects, 1);
});

test('Dynamic validates its whole configuration before claiming members and fixes its progression at construction', async () => {
  const occupied = new Node({ run: () => 1 });
  new Group().add(occupied);
  const free = new Node({ run: () => 2 });
  const decision = new Node({ run: () => ({ kind: 'finish', value: 1 }) });
  assert.throws(() => new Dynamic({ options: { free, occupied }, decide: decision }), /parent/);
  assert.throws(() => new Dynamic({ options: { free }, decide: occupied }), /parent/);
  assert.throws(() => new Dynamic({ options: { free } }), /Node|Group|member/i);
  assert.throws(() => new Dynamic({ options: { free }, decide: decision, maxSteps: -1 }), RangeError);
  assert.throws(() => new Dynamic({ options: { free, invalid: {} }, decide: decision }), /Node|Group|member/i);
  const dynamic = new Dynamic({ options: { free }, decide: decision, maxSteps: 3 });
  assert.equal(dynamic.maxSteps, 3);
  assert.throws(() => {
    dynamic.maxSteps = 4;
  }, TypeError);
  assert.equal(await install(dynamic).run(null), 1);
  assert.throws(() => dynamic.add(new Node()), /locked/);
  assert.throws(() => {
    dynamic.maxSteps = 5;
  }, TypeError);
  assert.equal(dynamic.options, undefined);
  assert.equal(dynamic.decide, undefined);
});

test('preset run functions cannot be replaced, and Dynamic snapshots non-enumerable candidate names', async () => {
  const sequence = new Sequence([]);
  assert.throws(() => {
    sequence.run = () => 'replacement';
  }, TypeError);
  let invoked = false;
  const node = new Node({
    run: () => {
      invoked = true;
    },
  });
  const decision = new Node({ run: () => (invoked ? { kind: 'finish', value: 'done' } : { kind: 'call', option: 'hidden', input: null }) });
  const options = Object.defineProperty({}, 'hidden', { value: node, writable: true, configurable: true });
  const configuration = { options, decide: decision, maxSteps: 1 };
  const dynamic = new Dynamic(configuration);
  const earlierAlias = dynamic;
  assert.throws(() => {
    dynamic.run = () => 'replacement';
  }, TypeError);
  const replacement = new Node({ run: () => assert.fail('replacement must not run') });
  options.hidden = replacement;
  options.extra = replacement;
  configuration.options = { replacement };
  configuration.decide = replacement;
  configuration.maxSteps = 0;
  assert.deepEqual(dynamic.names, {});
  assert.deepEqual(dynamic.members, [node, decision]);
  assert.equal(dynamic.maxSteps, 1);
  assert.equal(earlierAlias, dynamic);
  assert.equal(await install(dynamic).run(null), 'done');
  assert.doesNotThrow(() => new Group().add(replacement));
});

test('concurrent calls to one Sequence retain independent accepted values', async () => {
  const entered = deferred();
  const release = deferred();
  const waiting = new Node({
    run: async (work) => {
      if (work.input === 'left') {
        entered.resolve();
        await release.promise;
      }
      return work.input;
    },
  });
  const format = new Node({ run: (work) => `${work.input}:complete` });
  const sequence = new Sequence([waiting, format]);
  const scene = new Scene().add({ sequence });
  scene.run = async (work) => {
    const left = work.children.sequence.invoke('left');
    await entered.promise;
    const right = await work.children.sequence.invoke('right');
    release.resolve();
    return [await left, right];
  };
  assert.deepEqual(await new Runner(scene, new Resources()).build().run(null), ['left:complete', 'right:complete']);
});

test('cancellation does not enter a Sequence failed handler or advance a Dynamic loop', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let decisions = 0;
  let handled = 0;
  const action = new Sequence([
    {
      node: new Node({
        run: async () => {
          entered.resolve();
          await release.promise;
          return 'late';
        },
      }),
      result: { failed: () => ++handled },
    },
  ]);
  const dynamic = new Dynamic({
    options: { action },
    decide: new Node({
      run: () => {
        decisions++;
        return { kind: 'call', option: 'action', input: null };
      },
    }),
  });
  const pending = install(dynamic).run(null, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'INVOCATION_CANCELLED' });
  await entered.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.equal(decisions, 1);
  assert.equal(handled, 0);
});
