import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeDefinition, ExecutionDefinition, MemoryCheckpointStore, assembleRuntime } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/server-runtime/content';
import { GenerateAnswerDefinition, ModelInteractions, ModelSource, ModelResource, ModelSettingsResource } from '@capix/observer-service/conversation';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 256, timeoutMs: 1000 };
const input = { selection: { historyIndexes: [] }, memories: [] };
const answer = { kind: 'answer', content: '已固定的回答' };
const feedback = (content = JSON.stringify(answer)) => ({ id: 'fixture-output', model: 'fixture', content, finishReason: 'stop', usage: null });
const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };

class CapturedStore extends MemoryCheckpointStore {
  writes = [];
  save(image, revision) {
    const head = super.save(image, revision);
    this.writes.push({ kind: 'save', image, revision });
    return head;
  }
  finish(id, revision, delivery) {
    const head = super.finish(id, revision, delivery);
    this.writes.push({ kind: 'finish', id, revision, delivery });
    return head;
  }
}

function parentCheckpoint(key, child) {
  return {
    key,
    version: 1,
    input: codec,
    output: codec,
    points: {
      waiting: {
        state: codec,
        resume: {
          requires: {},
          uses: [child],
          async execute(_context, invocation, children, state) {
            const call = children.get(child).resume(invocation, state.childId);
            await call.run();
            return children.accept(call, (value) => value);
          },
        },
      },
    },
  };
}

function harness(t, provider, store, events = [], facts = []) {
  const generation = new GenerateAnswerDefinition();
  const interactions = new ModelInteractions(new ModelSource(provider));
  t.after(() => interactions.close());
  const transcript = new Transcript([{ role: 'user', content: '你好' }]);
  class Execution extends ExecutionDefinition {
    children = [generation];
    checkpoint = parentCheckpoint('fixture.answer.execution', generation);
    run = {
      requires: GenerateAnswerDefinition.requires,
      async execute(context, invocation, children) {
        const call = children.get(generation).create(invocation, context.input, { key: 'generation', output: { receive: (event) => void events.push(event) } });
        invocation.checkpoint?.save('waiting', { childId: call.context.id });
        await call.run();
        return children.accept(call, (value) => value);
      },
    };
  }
  const execution = new Execution();
  class Root extends RuntimeDefinition {
    children = [execution];
    checkpoint = parentCheckpoint('fixture.answer.runtime', execution);
    run = {
      requires: {},
      async execute(context, invocation, children) {
        const call = children.get(execution).create(invocation, context.input, { key: 'execution' });
        invocation.checkpoint?.save('waiting', { childId: call.context.id });
        await call.run();
        return children.accept(call, (value) => value);
      },
    };
  }
  const runtime = assembleRuntime(new Root(), {
    ...(store ? { checkpoints: { store, observation: { observe: (fact) => facts.push(fact) } } } : {}),
    providers: [ModelSettingsResource.snapshot.provide(() => settings), ModelSettingsResource.timeout.provide(() => settings.timeoutMs), TranscriptResource.fixedRange.provide(() => transcript.segments()[0]), ModelResource.create.provide(() => interactions), ModelResource.read.provide(() => interactions)],
    source: { entry: () => null, capture: () => null },
  });
  return { runtime, generation };
}

function restoreWrites(writes) {
  const store = new MemoryCheckpointStore();
  for (const entry of writes) {
    if (entry.kind === 'save') store.save(entry.image, entry.revision);
    else store.finish(entry.id, entry.revision, entry.delivery);
  }
  return store;
}

test('answer checkpoint codecs remain dormant when checkpoints are not installed', async (t) => {
  const original = harness(t, { invoke: async () => feedback() });
  original.generation.checkpoint.input = { encode: () => assert.fail('checkpoint capture is not installed'), decode: () => assert.fail('not restoring') };
  assert.deepEqual(await original.runtime.run(input, {}), answer);
});

for (const boundary of ['modelFeedback', 'modelDelivery', 'answerAccepted']) {
  test(`real answer declaration resumes ${boundary} with no model construction, preparation replay or preview replay`, async (t) => {
    const store = new CapturedStore();
    const outputEvents = [];
    let calls = 0;
    const original = harness(
      t,
      {
        async invoke(_request, _purpose, _signal, progress) {
          calls++;
          progress?.publish({ text: '{"kind":"answer","content":"已固定的' });
          progress?.publish({ text: '回答"}' });
          return feedback();
        },
      },
      store,
      outputEvents,
    );
    assert.deepEqual(await original.runtime.run(input, {}), answer);
    assert.equal(calls, 1);
    assert.equal(
      outputEvents
        .filter((event) => event.kind === 'delta')
        .map((event) => event.delta.text)
        .join(''),
      answer.content,
    );
    const rootId = store.writes[0].image.frame.owner.contextId;
    const model = store.writes.find((entry) => entry.kind === 'save' && entry.image.point === 'feedbackAccepted');
    const end = store.writes.findIndex((entry) => (boundary === 'modelFeedback' ? entry === model : boundary === 'modelDelivery' ? entry.kind === 'finish' && entry.id === model.image.frame.owner.contextId : entry.kind === 'save' && entry.image.point === 'answerAccepted'));
    assert.ok(end > 0);
    const resumedStore = restoreWrites(store.writes.slice(0, end + 1));
    const restoredEvents = [];
    const facts = [];
    let constructions = 0;
    const restored = harness(
      t,
      () => {
        constructions++;
        assert.fail('no model access during restoration');
      },
      resumedStore,
      restoredEvents,
      facts,
    );
    assert.deepEqual(await restored.runtime.resume(rootId, {}), answer);
    assert.equal(constructions, 0);
    assert.equal(restoredEvents.length, 0, 'historical output consumers are not reconstructed');
    const created = facts.filter((fact) => fact.kind === 'activity' && fact.fact.kind === 'started').map((fact) => fact.fact.description.name);
    assert.ok(!created.includes('assembleContext'));
    assert.ok(!created.includes('prepareModelRequest'));
    assert.ok(!created.includes('invokeModel'));
    assert.equal(created.filter((name) => name === 'acceptModelOutput').length, boundary === 'answerAccepted' ? 0 : 1);
  });
}

test('installed checkpoints preserve normal second-generation success and its actual final round', async (t) => {
  const store = new CapturedStore();
  const answers = [feedback('invalid JSON'), feedback()];
  let calls = 0;
  const original = harness(
    t,
    {
      invoke: async () => {
        calls++;
        return answers.shift();
      },
    },
    store,
  );
  assert.deepEqual(await original.runtime.run(input, {}), answer);
  assert.equal(calls, 2);
  const generation = store.writes.find((entry) => entry.kind === 'save' && entry.image.point === 'modelWaiting');
  const final = store.read(generation.image.frame.owner.contextId);
  assert.equal(final.delivery.status, 'succeeded');
  assert.equal(final.delivery.progress.round, 2);
  assert.deepEqual(final.delivery.output, answer);
  assert.ok(store.writes.some((entry) => entry.kind === 'save' && entry.image.point === 'answerAccepted' && entry.image.frame.round === 2));
});

test('second-round model feedback resumes with its prior rejection history and never requests a third generation', async (t) => {
  const store = new CapturedStore();
  const answers = [feedback('invalid JSON'), feedback()];
  let calls = 0;
  const original = harness(
    t,
    {
      invoke: async () => {
        calls++;
        return answers.shift();
      },
    },
    store,
  );
  await original.runtime.run(input, {});
  assert.equal(calls, 2);
  const modelImages = store.writes.filter((entry) => entry.kind === 'save' && entry.image.point === 'feedbackAccepted');
  assert.equal(modelImages.length, 2);
  // The second request's feedback was saved, but its parent O had not yet committed final delivery.
  const boundary = store.writes.indexOf(modelImages[1]);
  const resumedStore = restoreWrites(store.writes.slice(0, boundary + 1));
  let constructions = 0;
  const restored = harness(
    t,
    () => {
      constructions++;
      assert.fail('recovery cannot send a third request');
    },
    resumedStore,
  );
  const rootId = store.writes[0].image.frame.owner.contextId;
  assert.deepEqual(await restored.runtime.resume(rootId, {}), answer);
  assert.equal(constructions, 0);
  assert.equal(resumedStore.read(rootId).delivery.status, 'succeeded');
  const staleBoundary = store.writes.indexOf(modelImages[0]);
  const stale = harness(t, () => assert.fail('stale rejected feedback cannot send again'), restoreWrites(store.writes.slice(0, staleBoundary + 1)));
  await assert.rejects(stale.runtime.resume(rootId, {}), { code: 'CHECKPOINT_ANSWER_REJECTED' });
});

test('answer recovery refuses a child without durable feedback instead of issuing the request', async (t) => {
  const store = new CapturedStore();
  const original = harness(t, { invoke: async () => feedback() }, store);
  await original.runtime.run(input, {});
  const boundary = store.writes.findIndex((entry) => entry.kind === 'save' && entry.image.point === 'modelWaiting');
  const restored = harness(t, () => assert.fail('unknown request must never be reissued'), restoreWrites(store.writes.slice(0, boundary + 1)));
  await assert.rejects(restored.runtime.resume(store.writes[0].image.frame.owner.contextId, {}), /no durable continuation/);
});

test('answer checkpoint codecs preserve declared optional input and reject extra fields or invalid output', () => {
  const definition = new GenerateAnswerDefinition();
  const checkpoint = definition.checkpoint;
  assert.deepEqual(checkpoint.input.encode({ ...input, task: undefined, document: undefined }), input);
  assert.deepEqual(checkpoint.input.decode(checkpoint.input.encode(input)), input);
  assert.throws(() => checkpoint.input.decode({ ...input, extra: true }));
  assert.throws(() => checkpoint.input.decode({ ...input, selection: { historyIndexes: [0, 0] } }));
  assert.throws(() => checkpoint.output.decode({ kind: 'answer', content: '' }));
  let accesses = 0;
  const withGetter = {
    ...input,
    get document() {
      accesses++;
      return undefined;
    },
  };
  assert.throws(() => checkpoint.input.encode(withGetter), /accessor/);
  assert.equal(accesses, 0);
  assert.notEqual(checkpoint.key, new GenerateAnswerDefinition({ document: true }).checkpoint.key);
});

test('answer continuation checks the exact child identity and accepted output before running', async (t) => {
  const store = new CapturedStore();
  const original = harness(t, { invoke: async () => feedback() }, store);
  await original.runtime.run(input, {});
  for (const point of ['modelWaiting', 'answerAccepted']) {
    const boundary = store.writes.findIndex((entry) => entry.kind === 'save' && entry.image.point === point);
    const writes = structuredClone(store.writes.slice(0, boundary + 1));
    const image = writes.at(-1).image;
    if (point === 'modelWaiting') image.state.childId = image.frame.children[0].identity.contextId;
    else image.state.content = 'not the accepted output';
    const restored = harness(t, () => assert.fail('invalid recovery cannot acquire a provider'), restoreWrites(writes));
    await assert.rejects(restored.runtime.resume(store.writes[0].image.frame.owner.contextId, {}), point === 'modelWaiting' ? /exact waiting model child/ : /accepted model result/);
  }
});

for (const stage of ['context', 'request', 'regenerationRequest', 'acceptance']) {
  test(`answer continues its fixed ${stage} child before parent reception`, async (t) => {
    const store = new CapturedStore();
    const outputs = stage === 'regenerationRequest' ? [feedback('invalid JSON'), feedback()] : [feedback()];
    const original = harness(t, { invoke: async () => outputs.shift() }, store);
    assert.deepEqual(await original.runtime.run(input, {}), answer);
    const key = stage === 'context' ? 'observer.assemble-answer-context' : stage === 'acceptance' ? 'observer.accept-model-output' : 'observer.prepare-model-request';
    const candidates = store.writes.filter((write) => write.kind === 'save' && write.image.contract.key === key && write.image.point === 'result');
    const boundary = store.writes.indexOf(candidates[stage === 'regenerationRequest' ? 1 : 0]);
    assert.ok(boundary > 0);
    let calls = 0;
    const restored = harness(
      t,
      {
        invoke: async () => {
          calls++;
          return feedback();
        },
      },
      restoreWrites(store.writes.slice(0, boundary + 1)),
    );
    assert.deepEqual(await restored.runtime.resume(store.writes[0].image.frame.owner.contextId, {}), answer);
    assert.equal(calls, stage === 'acceptance' ? 0 : 1, 'only subsequent unsent model work may start');
  });
}

test('second-round preparation and model checkpoints retain the actual rejection diagnostic', async (t) => {
  const store = new CapturedStore();
  const outputs = [feedback('invalid JSON'), feedback()];
  const original = harness(t, { invoke: async () => outputs.shift() }, store);
  await original.runtime.run(input, {});
  for (const point of ['requestWaiting', 'modelWaiting']) {
    const image = store.writes.find((write) => write.kind === 'save' && write.image.contract.key.startsWith('observer.generate-answer') && write.image.frame.round === 2 && write.image.point === point).image;
    const frame = structuredClone(image.frame);
    const request = frame.children.find((child) => child.round === 2 && child.key === 'request');
    request.input.error = { code: 'EMPTY_OUTPUT', message: 'different declared rejection' };
    assert.throws(() => original.generation.checkpoint.points[point].check(frame, image.state), /rejection evidence/);
  }
});
