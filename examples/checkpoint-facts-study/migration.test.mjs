import assert from 'node:assert/strict';
import { test } from 'node:test';
// Dynamic package imports are required: hooks must be installed BEFORE their loading.
import './migration-hooks.mjs';
import { fixed, statistics, StableBoundaryFailure } from './migration-values.mjs';

const { Invocation, InvocationContext } = await import('@capix/invocation');
const { Runner, Resources, Scene, Node } = await import('@capix/server-runtime');
const { ResourceOffer } = await import('@capix/resources');
const signal = new AbortController().signal;
const { MemoryCheckpointStore } = await import('@capix/checkpoint');
const { Memory } = await import('@capix/memory');
const { Transcript } = await import('@capix/transcript');
const codec = { encode: (value) => value, decode: (value) => value };

test('automatic input boundary precedes capture; raw aliases remain editable', async () => {
  const raw = { path: 'a.txt', nested: { n: 1 } };
  let captured;
  const offer = new ResourceOffer({ expose: (value) => value });
  const scene = new Scene({
    deps: { path: offer.request() },
    run: (work) => {
      assert.equal(work.input, captured);
      assert.throws(() => {
        work.input.nested.n++;
      }, TypeError);
      return { path: work.resources.path, input: work.input };
    },
  });
  const resources = new Resources();
  resources
    .capture(scene, (input) => {
      captured = input;
      raw.path = 'b.txt';
      raw.nested.n = 2;
      return input.path;
    })
    .register(offer, (path) => path);
  const result = await new Runner(scene, resources).build().run(raw);
  assert.equal(result.path, 'a.txt');
  assert.deepEqual(result.input, { path: 'a.txt', nested: { n: 1 } });
  assert.notEqual(result.input, raw);
  assert.equal(Object.isFrozen(raw), false);
});

test('automatic return fixes before Work.close; fixing does not authorize successful close', async () => {
  for (const broken of [false, true]) {
    const raw = { text: 'body' };
    const error = new Error('close failed');
    let candidate;
    const invocation = new Invocation({
      signal,
      context: new InvocationContext(null),
      work: {
        execute: () => raw,
        close() {
          raw.text = 'changed by cleanup';
          return broken ? { status: 'failed', failure: error } : { status: 'succeeded', value: undefined };
        },
      },
      progress: {
        receive(event) {
          if (event.type === 'return') candidate = event.output;
        },
      },
    });
    if (broken) await assert.rejects(invocation.run(), (failure) => failure === error);
    else assert.deepEqual(await invocation.run(), { text: 'body' });
    assert.equal(raw.text, 'changed by cleanup');
    assert.equal(invocation.context.status, broken ? 'failed' : 'succeeded');
    if (candidate) assert.equal(candidate.text, 'body');
  }
});

test('automatic returned and accepted values remain stable before the FIRST CP, CP on or off', async () => {
  for (const enabled of [false, true]) {
    const rawOutput = { text: 'child' };
    const rawAccepted = { text: 'accepted' };
    const store = new MemoryCheckpointStore();
    let childOutputEncodes = 0;
    let pointChecks = 0;
    let child, relation, oldHead, parent;
    const binding = {
      key: 'study.auto.child',
      version: 1,
      input: codec,
      output: {
        encode(value) {
          childOutputEncodes++;
          return value;
        },
        decode: codec.decode,
      },
      points: {},
    };
    const context = new InvocationContext({ query: 'hi' });
    parent = new Invocation({
      signal,
      context,
      identity: { contextId: context.id, kind: 'scene' },
      ...(enabled ? { checkpoints: { store } } : {}),
      work: {
        checkpoint: {
          key: 'study.auto.parent',
          version: 1,
          input: codec,
          output: codec,
          children: [{ kind: 'node', binding }],
          points: {
            accepted: {
              state: codec,
              check() {
                pointChecks++;
              },
              execute() {
                throw new Error('not restoring');
              },
            },
          },
        },
        async execute(_context, invocation) {
          const cc = new InvocationContext(context.input);
          child = new Invocation({ signal, context: cc, parent: { invocation, declarationPosition: 0 }, identity: { contextId: cc.id, parentContextId: context.id, kind: 'node' }, work: { checkpoint: binding, execute: () => rawOutput } });
          const output = await child.run();
          rawOutput.text = 'changed';
          assert.equal(output.text, 'child');
          relation = invocation.children.get(child);
          const accepted = await relation.accept(() => rawAccepted);
          rawAccepted.text = 'changed';
          assert.equal(accepted.text, 'accepted');
          if (enabled) {
            invocation.checkpointWriter.save('accepted', null);
            oldHead = store.read(context.id);
            invocation.checkpointWriter.save('accepted', null);
            assert.equal(oldHead.image.frame.children[0].state.output.text, 'child');
            assert.equal(oldHead.image.frame.children[0].state.reception.output.text, 'accepted');
          }
          return accepted;
        },
      },
    });
    const output = await parent.run();
    assert.equal(output, relation.reception.output);
    assert.equal(relation.returned.output, child.context.state.output);
    assert.equal(relation.returned.output.text, 'child');
    assert.equal(output.text, 'accepted');
    assert.equal(store.read(context.id)?.delivery?.status, enabled ? 'succeeded' : undefined);
    // A stable delivery does NOT yet change CP's codec/check scheduling.
    assert.equal(childOutputEncodes, enabled ? 2 : 0);
    assert.equal(pointChecks, enabled ? 2 : 0);
  }
});

test('automatic handled output is stable; original failure object identity is preserved', async () => {
  const failure = new Error('business failure');
  const fallback = { text: 'fallback' };
  let relation;
  const parent = new Invocation({
    signal,
    context: new InvocationContext(null),
    work: {
      async execute(_ctx, invocation) {
        const child = new Invocation({
          signal,
          context: new InvocationContext(null),
          parent: { invocation, receiveFailure: true },
          work: {
            execute() {
              throw failure;
            },
          },
        });
        await assert.rejects(child.run(), (error) => error === failure);
        relation = invocation.children.get(child);
        const value = await relation.handle((error) => {
          assert.equal(error, failure);
          return fallback;
        });
        fallback.text = 'changed';
        return value;
      },
    },
  });
  assert.deepEqual(await parent.run(), { text: 'fallback' });
  assert.equal(relation.returned.error, failure);
  assert.equal(relation.reception.status, 'handled');
});

test('unsupported successful values are protected boundary failures, not business fallback', async () => {
  let handled = 0;
  const child = new Node({ run: () => new Date() });
  const scene = new Scene().add({ child });
  scene.run = (work) =>
    work.children.child.invoke(null, {
      result: {
        failed() {
          handled++;
          return 'masked';
        },
      },
    });
  await assert.rejects(new Runner(scene, new Resources()).build().run(null), /Stable delivery rejected/);
  assert.equal(handled, 0);
});

test('resource capabilities remain live and unmodified; only callable data is fixed', async () => {
  const capability = {
    read() {
      return { text: 'data' };
    },
  };
  const offer = new ResourceOffer({ expose: (origin) => origin });
  const scene = new Scene({
    deps: { reader: offer.request() },
    run: (work) => {
      assert.equal(work.resources.reader, capability);
      return work.resources.reader.read();
    },
  });
  const resources = new Resources();
  resources.register(offer, capability);
  assert.deepEqual(await new Runner(scene, resources).build().run(null), { text: 'data' });
  assert.equal(Object.isFrozen(capability), false);
});

test('every fixing failure stays protected, including primitive throws and unreadable diagnostics', async () => {
  const inaccessible = Object.defineProperty({}, 'message', {
    get() {
      throw new Error('must not read a failure getter');
    },
  });
  const opaque = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw undefined;
      },
    },
  );
  for (const cause of [undefined, null, 'private-body-fragment', new Error('private-body-fragment'), inaccessible, opaque]) {
    let handled = 0;
    const value = new Proxy(
      {},
      {
        ownKeys() {
          throw cause;
        },
      },
    );
    const child = new Node({ run: () => value });
    const scene = new Scene().add({ child });
    scene.run = (work) =>
      work.children.child.invoke(null, {
        result: {
          failed() {
            handled++;
            return 'masked';
          },
        },
      });
    await assert.rejects(new Runner(scene, new Resources()).build().run(null), (error) => error instanceof StableBoundaryFailure && error.cause === cause);
    assert.equal(handled, 0);
  }
  assert.equal(JSON.stringify(statistics()).includes('private-body-fragment'), false);
});

test('entity snapshot reuse and new aggregate cost are separately visible', async () => {
  const transcript = new Transcript([{ role: 'user', content: 'hello' }]);
  const memory = new Memory(transcript, { topic: 't', content: 'remember', sourceIndexes: [0] });
  const snapshot = memory.snapshot();
  const before = statistics();
  const one = fixed(snapshot, 'probe:entity');
  const afterFirst = statistics();
  const two = fixed(one, 'probe:forward');
  assert.equal(two, one);
  assert.equal(statistics().visits, afterFirst.visits);
  if (process.env.CAPIX_STABLE_STUDY_ENTITIES === '1') {
    assert.equal(one, snapshot);
    assert.equal(afterFirst.visits, before.visits);
  } else {
    assert.notEqual(one, snapshot);
    assert.ok(afterFirst.visits > before.visits);
  }
  const prefix = transcript.snapshot();
  const beforePrefix = statistics().visits;
  const stablePrefix = fixed(prefix, 'probe:prefix');
  assert.ok(statistics().visits > beforePrefix, 'a new prefix array still has construction/fixing work');
  assert.notEqual(stablePrefix, prefix);
});

test('the probe really loaded the automatic boundary modules', () => {
  const stats = statistics();
  for (const boundary of ['input:before-capture', 'input:context', 'output:before-settle-close', 'reception:before-check']) assert.ok(stats.boundaries[boundary] > 0, boundary);
  assert.ok(stats.modules.includes('server/invocation/dist/operation/failure.js'));
});
