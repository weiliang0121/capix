import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleRuntime, RuntimeDefinition, ExecutionDefinition, OperationDefinition, InvocationContext, InvocationChildren, Transcript, TranscriptResource, MemoryCheckpointStore } from '@capix/server-runtime';
import { runtimeDefinition } from '../fixtures/declarations.mjs';

class Answer extends OperationDefinition {
  name = 'answer';
  label = 'answer';
  source = 'test';
  run = { requires: {}, execute: () => 'fixed answer' };
}

function assemble(execution, transcript, progress = []) {
  return assembleRuntime(runtimeDefinition(execution), {
    providers: [TranscriptResource.append.provide(() => transcript)],
    source: {
      entry: () => null,
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
  class Main extends ExecutionDefinition {
    run = {
      requires: { messages: TranscriptResource.append.request() },
      execute(work) {
        assert.throws(() => work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: 'not accepted' }] }), /active direct-child reception/);
        return 'caught';
      },
    };
  }
  await assert.rejects(assemble(new Main(), transcript).run(null, {}), /active direct-child reception/);
  assert.equal(transcript.length, 0);
});

test('fixed transcript writes derive parent and child identity from the actual reception', async () => {
  const transcript = new Transcript();
  const answer = new Answer();
  const progress = [];
  class Main extends ExecutionDefinition {
    children = [answer];
    run = {
      requires: { messages: TranscriptResource.append.request() },
      async execute(work) {
        const child = work.children.create(answer, null);
        await child.run();
        return child.accept((content) => {
          const first = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
          const confirmed = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
          assert.equal(first, confirmed);
          return confirmed;
        });
      },
    };
  }
  const receipt = await assemble(new Main(), transcript, progress).run(null, {});
  const parentId = progress.find((f) => f.kind === 'started' && f.identity.level === 'execution').identity.contextId;
  const childId = progress.find((f) => f.kind === 'started' && f.identity.level === 'operation').identity.contextId;
  assert.deepEqual(receipt, { transcriptId: transcript.id, start: 0, count: 1, revision: 1 });
  assert.deepEqual(transcript.exportState().appends[0].request.operation, { parentContextId: parentId, childContextId: childId, position: 'answer' });
  assert.equal(transcript.length, 1);
});

for (const stale of [undefined, 'endpoint', 'view']) {
  test(`a second work round ${stale ? `rejects a retained old ${stale}` : 'obtains a new endpoint with the new reception'}`, async () => {
    const transcript = new Transcript();
    const answer = new Answer();
    let firstEndpoint;
    let firstValues;
    const progress = [];
    class Main extends ExecutionDefinition {
      children = [answer];
      maxRounds = 2;
      run = {
        requires: { messages: TranscriptResource.append.request() },
        async execute(work) {
          const endpoint = work.resources.messages;
          if (work.round === 1) {
            firstEndpoint = endpoint;
            firstValues = work.resources;
          } else assert.notEqual(endpoint, firstEndpoint);
          const child = work.children.create(answer, null);
          await child.run();
          return child.accept((content) => {
            if (stale && work.round === 2) {
              const retained = stale === 'view' ? firstValues.messages : firstEndpoint;
              return retained.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
            }
            return endpoint.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
          });
        },
        accept: (work) => (work.round === 1 ? work.continue(work.initialInput, 'second round') : work.delivered),
      };
    }
    const execution = assemble(new Main(), transcript, progress).run(null, {});
    if (stale) {
      await assert.rejects(execution, /inactive declaration round/);
      assert.equal(transcript.length, 1);
    } else {
      assert.equal((await execution).start, 1);
      assert.equal(transcript.length, 2);
      assert.deepEqual(
        transcript.exportState().appends.map((saved) => saved.request.operation.childContextId),
        progress.filter((f) => f.kind === 'started' && f.identity.level === 'operation').map((f) => f.identity.contextId),
      );
    }
  });
}

test('concurrent receptions retain separate identities across await', async () => {
  const context = new InvocationContext(null);
  context.startRound(1, null);
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

test('a checkpoint writer retained from a previous round cannot save the current work', async () => {
  const codec = { encode: (value) => value, decode: (value) => value };
  const store = new MemoryCheckpointStore();
  let writer;
  class Root extends RuntimeDefinition {
    maxRounds = 2;
    checkpoint = { key: 'test.round-writer', version: 1, input: codec, output: codec, points: [{ name: 'saved', state: codec, references: {}, resume: { requires: {}, execute: () => null } }] };
    run = {
      requires: {},
      execute: (work) => {
        if (work.round === 1) writer = work.checkpoint;
        else assert.throws(() => writer.save(this.checkpoint.points[0], null, {}), /inactive declaration|outside its executing round/);
        return null;
      },
      accept: (work) => (work.round === 1 ? work.continue(work.initialInput, 'next') : work.delivered),
    };
  }
  const runtime = assembleRuntime(new Root(), { checkpoints: { store }, providers: [], source: { entry: () => null, capture: () => null } });
  await assert.rejects(runtime.run(null, {}), /inactive declaration|outside its executing round/);
  assert.equal(runtime.running, false);
});

test('parallel fixed appends bind each effect to its own asynchronous reception', async () => {
  const progress = [];
  const transcript = new Transcript();
  const answer = new Answer();
  class Main extends ExecutionDefinition {
    children = [answer];
    run = {
      requires: { messages: TranscriptResource.append.request() },
      async execute(work) {
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
            .filter((f) => f.kind === 'started' && f.identity.level === 'operation')
            .map((f) => f.identity.contextId)
            .reverse(),
        );
        return 'accepted';
      },
    };
  }
  assert.equal(await assemble(new Main(), transcript, progress).run(null, {}), 'accepted');
  assert.equal(transcript.length, 2);
});

test('a callback escaping its completed reception cannot borrow a later reception identity', async () => {
  const context = new InvocationContext(null);
  context.startRound(1, null);
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
