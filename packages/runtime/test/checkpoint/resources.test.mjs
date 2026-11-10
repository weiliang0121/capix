import { installCallable } from '../fixtures/driver.mjs';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Scene, Group, InvocationContext, InvocationChildren } from '@weiliang0121/capix-runtime';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

import { runtimeDefinition } from '../fixtures/declarations.mjs';

class Answer extends Group {
  name = 'answer';
  label = 'answer';
  source = 'test';
  deps = {};
  run = () => 'fixed answer';
}

function assemble(execution, transcript, progress = []) {
  return installCallable(runtimeDefinition(execution), {
    providers: [TranscriptResource.append.provide(() => transcript)],
    source: {
      capture: () => null,
      progress: () => ({
        receive: (fact) => {
          progress.push(fact);
        },
      }),
    },
  });
}

test('fixed transcript writes require a real direct-child reception and cannot be swallowed', async () => {
  const transcript = new Transcript();
  class Main extends Group {
    deps = { messages: TranscriptResource.append.request() };
    run = function (work) {
      assert.throws(
        () => work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: 'not accepted' }] }),
        (error) => error.name === 'ResourcePortError' && /active direct-child reception/.test(error.cause?.message),
      );
      return 'caught';
    };
  }
  await assert.rejects(assemble(new Main(), transcript).run(null, {}), (error) => error.name === 'ResourcePortError' && /active direct-child reception/.test(error.cause?.message));
  assert.equal(transcript.length, 0);
});

test('fixed transcript writes derive parent and child identity from the actual reception', async () => {
  const transcript = new Transcript();
  const answer = new Answer();
  const progress = [];
  class Main extends Group {
    constructor() {
      super();
      this.add(answer);
    }
    deps = { messages: TranscriptResource.append.request() };
    run = async function (work) {
      const child = work.children.create(answer, null);
      await child.run();
      return child.accept((content) => {
        const first = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
        const confirmed = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
        assert.equal(first, confirmed);
        return confirmed;
      });
    };
  }
  const receipt = await assemble(new Main(), transcript, progress).run(null, {});
  const parentId = progress.find((f) => f.kind === 'started' && f.identity.kind === 'group' && f.description?.name !== 'answer').identity.contextId;
  const childId = progress.find((f) => f.kind === 'started' && f.description?.name === 'answer').identity.contextId;
  assert.deepEqual(receipt, { transcriptId: transcript.id, start: 0, count: 1, revision: 1 });
  assert.deepEqual(transcript.exportState().appends[0].request.operation, { parentContextId: parentId, childContextId: childId, position: 'answer' });
  assert.equal(transcript.length, 1);
});

for (const stale of [undefined, 'endpoint', 'view']) {
  test(`a later invocation ${stale ? `rejects the old ${stale}` : 'gets a fresh resource endpoint and reception'}`, async () => {
    const transcript = new Transcript(),
      answer = new Answer(),
      progress = [];
    let firstEndpoint, firstValues;
    class Main extends Group {
      constructor() {
        super();
        this.add(answer);
      }
      deps = { messages: TranscriptResource.append.request() };
      run = async (work) => {
        const endpoint = work.resources.messages;
        if (!firstEndpoint) {
          firstEndpoint = endpoint;
          firstValues = work.resources;
        } else assert.notEqual(endpoint, firstEndpoint);
        return work.children.invoke(answer, null, {
          result: {
            succeeded(content) {
              const retained = stale && work.input === 'second' ? (stale === 'view' ? firstValues.messages : firstEndpoint) : endpoint;
              return retained.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
            },
          },
        });
      };
    }
    const runtime = assemble(new Main(), transcript, progress);
    assert.equal((await runtime.run('first', {})).start, 0);
    if (stale) {
      await assert.rejects(runtime.run('second', {}), /already ended|window|inactive/);
      assert.equal(transcript.length, 1);
    } else {
      assert.equal((await runtime.run('second', {})).start, 1);
      assert.equal(transcript.length, 2);
      assert.deepEqual(
        transcript.exportState().appends.map((saved) => saved.request.operation.childContextId),
        progress.filter((f) => f.kind === 'started' && f.description?.name === 'answer').map((f) => f.identity.contextId),
      );
    }
  });
}

test('concurrent receptions retain separate identities across await', async () => {
  const context = new InvocationContext(null);
  context.start();
  const children = new InvocationChildren(context);
  const make = () => {
    const child = new InvocationContext(null);
    child.complete('answer');
    const target = { context: child, run: async () => 'answer' };
    const relation = children.attach(target);
    relation.returnedWith({ status: 'succeeded', output: 'answer' });
    return { relation, id: child.id };
  };
  const first = make();
  const second = make();
  const gate = Promise.withResolvers();
  const accepting = first.relation.accept(async () => {
    assert.equal(children.reception.childContextId, first.id);
    await gate.promise;
    assert.equal(children.reception.childContextId, first.id);
    return 'accepted';
  });
  assert.equal(
    await second.relation.accept(() => {
      assert.equal(children.reception.childContextId, second.id);
      return 'second';
    }),
    'second',
  );
  assert.throws(() => children.reception, /active direct-child reception/);
  gate.resolve();
  assert.equal(await accepting, 'accepted');
  assert.throws(() => children.reception, /active direct-child reception/);
});

test('a checkpoint writer retained from a completed invocation cannot save later work', async () => {
  const codec = { encode: (value) => value, decode: (value) => value },
    store = new MemoryCheckpointStore();
  let writer;
  class Root extends Scene {
    checkpoint = { key: 'test.closed-writer', version: 1, input: codec, output: codec, points: [{ name: 'saved', state: codec, references: {}, resume: { deps: {}, run: () => null } }] };
    run = (work) => {
      if (!writer) writer = work.checkpoint;
      else assert.throws(() => writer({ point: this.checkpoint.points[0], state: null, refs: {} }), /already ended|window|inactive/);
      work.checkpoint({ point: this.checkpoint.points[0], state: work.input, refs: {} });
      return work.input;
    };
  }
  const runtime = installCallable(new Root(), { checkpoints: { store }, providers: [], source: { capture: () => null } });
  assert.equal(await runtime.run('first', {}), 'first');
  assert.equal(await runtime.run('second', {}), 'second');
  assert.equal(runtime.running, false);
});

test('parallel fixed appends bind each effect to its own asynchronous reception', async () => {
  const progress = [];
  const transcript = new Transcript();
  const answer = new Answer();
  class Main extends Group {
    constructor() {
      super();
      this.add(answer);
    }
    deps = { messages: TranscriptResource.append.request() };
    run = async function (work) {
      const first = work.children.create(answer, null);
      const second = work.children.create(answer, null);
      await first.run();
      await second.run();
      const gate = Promise.withResolvers();
      const accepting = first.accept(async (content) => {
        await gate.promise;
        return work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
      });
      await second.accept((content) => work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] }));
      gate.resolve();
      await accepting;
      assert.deepEqual(
        transcript.exportState().appends.map((item) => item.request.operation.childContextId),
        progress
          .filter((f) => f.kind === 'started' && f.description?.name === 'answer')
          .map((f) => f.identity.contextId)
          .reverse(),
      );
      return 'accepted';
    };
  }
  assert.equal(await assemble(new Main(), transcript, progress).run(null, {}), 'accepted');
  assert.equal(transcript.length, 2);
});

test('a callback escaping its completed reception cannot borrow a later reception identity', async () => {
  const context = new InvocationContext(null);
  context.start();
  const children = new InvocationChildren(context);
  const relation = () => {
    const child = new InvocationContext(null);
    child.complete('value');
    const result = children.attach({ context: child, run: async () => 'value' });
    result.returnedWith({ status: 'succeeded', output: 'value' });
    return result;
  };
  const first = relation();
  const second = relation();
  const late = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let escaped;
  await first.accept(() => {
    escaped = late.promise.then(() => assert.throws(() => children.reception, /active direct-child reception/));
    return 'accepted';
  });
  const pending = second.accept(async () => {
    assert.equal(children.reception.childContextId, second.invocation.context.id);
    await finish.promise;
    assert.equal(children.reception.childContextId, second.invocation.context.id);
    return 'second';
  });
  late.resolve();
  await escaped;
  finish.resolve();
  assert.equal(await pending, 'second');
});
