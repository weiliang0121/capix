import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, checkpointPoint, childReference } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { RequestModel, ModelInteractions, ModelSource, ModelResource, ModelSettingsResource } from '@capix/observer-service/conversation';

const request = { model: 'fixture', messages: [{ role: 'user', content: 'fixed input' }], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 256, stream: false };
const output = { id: 'fixture-output', model: 'fixture', content: 'provider envelope before business JSON acceptance', finishReason: 'length', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } };
const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 256, timeoutMs: 1000 };

class CapturedStore extends MemoryCheckpointStore {
  images = [];
  save(image, revision) {
    const receipt = super.save(image, revision);
    this.images.push(this.read(receipt.contextId).image);
    return receipt;
  }
}

function parentCheckpoint(key, child) {
  return {
    key,
    version: 1,
    input: codec,
    output: codec,
    points: [
      checkpointPoint()({
        name: 'waiting',
        state: codec,
        references: { child: childReference(child) },
        resume: {
          deps: {},
          uses: [child],
          async run(work, _state, saved) {
            const call = work.children.resume(saved.child);
            await call.run();
            return call.accept();
          },
        },
      }),
    ],
  };
}

function harness(t, provider, store, facts = [], progress = () => {}, model = new RequestModel('answer')) {
  const interactions = new ModelInteractions(new ModelSource(provider));
  t.after(() => interactions.close());
  class Execution extends Group {
    constructor() {
      super();
      this.add(model);
    }
    checkpoint = parentCheckpoint('fixture.model.execution', model);
    deps = RequestModel.deps;
    run = async (work) => {
      const call = work.children.create(model, work.input, { key: 'model' });
      work.checkpoint?.({ point: this.checkpoint.points[0], state: {}, refs: { child: call.ref } });
      await call.run();
      return call.accept();
    };
  }
  const execution = new Execution();
  class Root extends Scene {
    constructor() {
      super();
      this.add(execution);
    }
    checkpoint = parentCheckpoint('fixture.model.runtime', execution);
    deps = {};
    run = async (work) => {
      const call = work.children.create(execution, work.input, { key: 'execution' });
      work.checkpoint?.({ point: this.checkpoint.points[0], state: {}, refs: { child: call.ref } });
      await call.run();
      return call.accept();
    };
  }
  const runtime = installCallable(new Root(), {
    ...(store ? { checkpoints: { store, observation: { observe: (fact) => facts.push(fact) } } } : {}),
    providers: [ModelSettingsResource.snapshot.provide(() => settings), ModelSettingsResource.timeout.provide(() => settings.timeoutMs), ModelResource.create.provide(() => interactions), ModelResource.read.provide(() => interactions)],
    source: { capture: () => null, progress: () => ({ receive: progress }) },
  });
  return { runtime, model };
}

test('request-model checkpoint is dormant without an installation and keeps the original complete feedback', async (t) => {
  let calls = 0;
  const model = new RequestModel('answer');
  model.checkpoint.input = { encode: () => assert.fail('checkpoint input codec must remain dormant'), decode: () => assert.fail('not restoring') };
  const { runtime } = harness(
    t,
    {
      invoke: async () => {
        calls++;
        return output;
      },
    },
    undefined,
    [],
    undefined,
    model,
  );
  const result = await runtime.run(request, {});
  assert.deepEqual(result, output);
  assert.equal(calls, 1);
});

for (const pending of [false, true]) {
  test(`request-model restores ${pending ? 'followed' : 'direct'} accepted feedback without creating or calling a provider`, async (t) => {
    let resolve;
    const deferred = new Promise((accept) => {
      resolve = accept;
    });
    let calls = 0;
    const store = new CapturedStore();
    const original = harness(
      t,
      {
        invoke: async () => {
          calls++;
          return pending ? deferred : output;
        },
      },
      store,
      [],
      (fact) => {
        if (pending && fact.description?.name === 'requestModel' && fact.kind === 'relation' && fact.phase === 'returned' && fact.relation.key === 'start') resolve(output);
      },
    );
    assert.deepEqual(await original.runtime.run(request, {}), output);
    assert.equal(calls, 1);
    const modelImage = store.images.find((image) => image.contract.key === original.model.checkpoint.key && image.point === 'feedbackAccepted');
    assert.ok(modelImage);
    assert.equal(modelImage.point, 'feedbackAccepted');
    assert.deepEqual(modelImage.state, output);
    assert.deepEqual(modelImage.frame.input, request);
    assert.deepEqual(
      modelImage.frame.children.map((child) => child.key),
      pending ? ['start', 'follow'] : ['start'],
    );
    assert.ok(modelImage.frame.children.every((child) => child.state.reception.kind === 'accepted'));
    const restoredStore = new MemoryCheckpointStore();
    // These images were captured before terminal delivery; the fixture models loss at that boundary.
    for (const image of store.images) restoredStore.save(image, restoredStore.read(image.frame.owner.contextId)?.revision ?? 0);
    let constructions = 0;
    const facts = [];
    const restored = harness(
      t,
      () => {
        constructions++;
        throw new Error('provider unavailable during recovery');
      },
      restoredStore,
      facts,
    );
    const root = store.images.find((image) => image.frame.owner.kind === 'scene');
    const result = await restored.runtime.resume(root.frame.owner.contextId, {});
    assert.deepEqual(result, output);
    assert.equal(constructions, 0);
    assert.equal(calls, 1);
    assert.ok(facts.some((fact) => fact.kind === 'installed' && fact.contextId === modelImage.frame.owner.contextId));
    assert.equal(facts.filter((fact) => fact.kind === 'resource').length, 0);
    assert.equal(facts.filter((fact) => fact.kind === 'activity' && fact.fact.identity.kind === 'node').length, 0, 'installing completed A facts never re-executes or re-observes those A calls');
  });
}

test('request-model checkpoint codecs reject incompatible saved envelopes without business JSON interpretation', () => {
  const definition = new RequestModel('answer');
  const checkpoint = definition.checkpoint;
  assert.deepEqual(checkpoint.input.decode(checkpoint.input.encode(request)), request);
  assert.deepEqual(checkpoint.output.decode(checkpoint.output.encode(output)), output);
  assert.deepEqual(definition.feedbackAccepted.state.decode(output), output, 'length and non-JSON content remain complete provider feedback, not an accepted answer');
  for (const invalid of [
    { ...request, extra: true },
    { ...request, max_tokens: '256' },
    { ...request, messages: [{ role: 'tool', content: 'not supported' }] },
  ])
    assert.throws(() => checkpoint.input.decode(invalid));
  for (const invalid of [
    { ...output, finishReason: 1 },
    { ...output, extra: true },
    { ...output, usage: { ...output.usage, promptTokens: -1 } },
  ]) {
    assert.throws(() => checkpoint.output.decode(invalid));
    assert.throws(() => definition.feedbackAccepted.state.decode(invalid));
  }
  assert.notEqual(checkpoint.key, new RequestModel('memory').checkpoint.key);
});

test('request-model recovery rejects a missing acceptance or mismatched saved output before accessing the model', async (t) => {
  const store = new CapturedStore();
  const original = harness(t, { invoke: async () => output }, store);
  await original.runtime.run(request, {});
  const rootId = store.images.find((image) => image.frame.owner.kind === 'scene').frame.owner.contextId;
  for (const mutate of [
    (image) => {
      image.frame.children[0].state.reception = { kind: 'pending' };
    },
    (image) => {
      image.state.content = 'unrelated result';
    },
  ]) {
    const restoredStore = new MemoryCheckpointStore();
    for (const originalImage of store.images) {
      const image = structuredClone(originalImage);
      if (image.contract.key === original.model.checkpoint.key && image.point === 'feedbackAccepted') mutate(image);
      restoredStore.save(image, restoredStore.read(image.frame.owner.contextId)?.revision ?? 0);
    }
    let constructions = 0;
    const restored = harness(
      t,
      () => {
        constructions++;
        assert.fail('rejected recovery cannot access a model');
      },
      restoredStore,
    );
    await assert.rejects(restored.runtime.resume(rootId, {}), /accepted child|direct feedback/);
    assert.equal(constructions, 0);
  }
});
