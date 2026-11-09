import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, checkpointPoint, childReference } from '@weiliang0121/capix-runtime';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { GenerateAnswer, ModelInteractions, ModelSource, ModelResource, ModelSettingsResource } from '@capix/observer-service/conversation';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 256, timeoutMs: 1000 };
const input = { context: { message: { role: 'user', content: '你好' }, selectedMessages: [] }, memories: [] };
const answer = { kind: 'answer', content: '已固定的回答' };
const feedback = (content = JSON.stringify(answer)) => ({ id: 'fixture-output', model: 'fixture', content, finishReason: 'stop', usage: null });
const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };

class CapturedStore extends MemoryCheckpointStore {
  writes = [];
  save(image, revision) {
    const head = super.save(image, revision);
    this.writes.push({ kind: 'save', image: this.read(head.contextId).image, commit: image, revision });
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

function harness(t, provider, store, events = [], facts = [], generation = new GenerateAnswer()) {
  const interactions = new ModelInteractions(new ModelSource(provider));
  t.after(() => interactions.close());
  class Execution extends Group {
    constructor() {
      super();
      this.add(generation);
    }
    checkpoint = parentCheckpoint('fixture.answer.execution', generation);
    deps = GenerateAnswer.deps;
    run = async (work) => {
      const call = work.children.create(generation, work.input, {
        key: 'generation',
        output: {
          receive: (event) => {
            if (event.kind === 'delta') events.push(event.delta);
          },
        },
      });
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
    checkpoint = parentCheckpoint('fixture.answer.runtime', execution);
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
    source: { capture: () => null },
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
  const generation = new GenerateAnswer();
  generation.checkpoint.input = { encode: () => assert.fail('checkpoint capture is not installed'), decode: () => assert.fail('not restoring') };
  const original = harness(t, { invoke: async () => feedback() }, undefined, [], [], generation);
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

test('installed checkpoints preserve two candidate identities inside one business execution', async (t) => {
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
  const generation = store.writes.find((entry) => entry.kind === 'save' && entry.image.point === 'candidateWaiting');
  const final = store.read(generation.image.frame.owner.contextId);
  assert.equal(final.delivery.status, 'succeeded');
  assert.equal(final.delivery.progress.round, 1);
  assert.deepEqual(final.delivery.output, answer);
  const completed = store.writes.findLast((entry) => entry.kind === 'save' && entry.image.point === 'answerAccepted' && entry.image.contract.key.startsWith('observer.generate-answer'));
  assert.equal(completed.image.frame.round, 1);
  assert.equal(completed.image.frame.children.filter((child) => child.key === 'candidate').length, 2);
});

test('second candidate model feedback resumes with its prior rejection history and never requests a third generation', async (t) => {
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
  const definition = new GenerateAnswer();
  const checkpoint = definition.checkpoint;
  assert.deepEqual(checkpoint.input.encode({ ...input, task: undefined, document: undefined }), input);
  assert.deepEqual(checkpoint.input.decode(checkpoint.input.encode(input)), input);
  assert.throws(() => checkpoint.input.decode({ ...input, extra: true }));
  assert.throws(() => checkpoint.input.decode({ ...input, context: { ...input.context, selectedMessages: [0, 0].map((index) => ({ index, message: input.context.message })) } }));
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
  assert.notEqual(checkpoint.key, new GenerateAnswer({ document: true }).checkpoint.key);
});

test('answer continuation checks the exact child identity and accepted output before running', async (t) => {
  const store = new CapturedStore();
  const original = harness(t, { invoke: async () => feedback() }, store);
  await original.runtime.run(input, {});
  for (const point of ['candidateWaiting', 'answerAccepted']) {
    const boundary = store.writes.findIndex((entry) => entry.kind === 'save' && entry.image.point === point && entry.image.contract.key.startsWith('observer.generate-answer'));
    const writes = structuredClone(store.writes.slice(0, boundary + 1));
    const image = writes.at(-1).image;
    if (point === 'candidateWaiting') {
      const unrelated = image.frame.children[0];
      image.references.candidate = { contextId: unrelated.identity.contextId, parentContextId: image.frame.owner.contextId, parentRound: unrelated.round, order: unrelated.order, target: unrelated.target };
    } else image.state.content = 'not the accepted output';
    const restored = harness(t, () => assert.fail('invalid recovery cannot acquire a provider'), restoreWrites(writes));
    await assert.rejects(restored.runtime.resume(store.writes[0].image.frame.owner.contextId, {}), point === 'candidateWaiting' ? /reference|declaration|slot|target/i : /accepted candidate/);
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
    let recoveredRejection = false;
    const generation = new GenerateAnswer();
    if (stage === 'regenerationRequest') {
      const resume = generation.regenerationWaiting.resume.run;
      generation.regenerationWaiting.resume.run = (work, state, refs) => {
        const rejection = work.children.facts.list(generation.candidate)[0];
        assert.equal(rejection.returned.status, 'failed');
        assert.equal(rejection.returned.diagnostic.code, 'MODEL_OUTPUT_REJECTED');
        assert.equal(rejection.returned.diagnostic.detail.code, 'INVALID_JSON');
        assert.equal(rejection.reception.status, 'handled');
        const received = work.children.facts.handled(rejection.ref, generation.candidateReception);
        assert.equal(received.kind, 'retry');
        assert.equal(received.basis.error.code, 'INVALID_JSON');
        assert.deepEqual(state, received.basis);
        recoveredRejection = true;
        return resume(work, state, refs);
      };
    }
    const restored = harness(
      t,
      {
        invoke: async () => {
          calls++;
          return feedback();
        },
      },
      restoreWrites(store.writes.slice(0, boundary + 1)),
      [],
      [],
      generation,
    );
    assert.deepEqual(await restored.runtime.resume(store.writes[0].image.frame.owner.contextId, {}), answer);
    assert.equal(calls, stage === 'acceptance' ? 0 : 1, 'only subsequent unsent model work may start');
    assert.equal(recoveredRejection, stage === 'regenerationRequest');
  });
}

test('retry preparation and candidate checkpoints retain the actual rejection diagnostic', async (t) => {
  const store = new CapturedStore();
  const outputs = [feedback('invalid JSON'), feedback()];
  const original = harness(t, { invoke: async () => outputs.shift() }, store);
  await original.runtime.run(input, {});
  for (const point of ['regenerationWaiting', 'candidateWaiting']) {
    const boundary = store.writes.findIndex((write) => write.kind === 'save' && write.image.contract.key.startsWith('observer.generate-answer') && write.image.point === point && (point !== 'candidateWaiting' || write.image.state.attempt === 2));
    assert.ok(boundary > 0);
    const writes = structuredClone(store.writes.slice(0, boundary + 1));
    const image = writes.at(-1).image;
    const request = image.frame.children.find((child) => child.key === 'regeneration');
    request.input.error = { code: 'EMPTY_OUTPUT', message: 'different declared rejection' };
    await assert.rejects(async () => {
      // Existing fixed child inputs may already be rejected by the Store import;
      // first appearances are checked against business rejection evidence on resume.
      const restored = harness(t, () => assert.fail('invalid continuation cannot access a model'), restoreWrites(writes));
      await restored.runtime.resume(writes[0].image.frame.owner.contextId, {});
    }, /rejection|regeneration|child identity and input cannot change/i);
  }
});

test('accepted retry checkpoint restores its handled rejection and creates only the unsent second candidate', async (t) => {
  const store = new CapturedStore();
  const outputs = [feedback('invalid JSON'), feedback()];
  const original = harness(t, { invoke: async () => outputs.shift() }, store);
  await original.runtime.run(input, {});
  const boundary = store.writes.findIndex((write) => write.kind === 'save' && write.image.point === 'regenerationReady');
  assert.ok(boundary > 0);
  const prefix = store.writes.slice(0, boundary + 1);
  const image = prefix.at(-1).image;
  assert.equal(image.frame.children.length, 3);
  assert.equal(image.frame.children.at(-1).state.reception.kind, 'handled');
  let requests = 0;
  const restored = harness(
    t,
    {
      invoke: async (request) => {
        requests++;
        assert.ok(request.messages.some((message) => message.role === 'assistant' && message.content === 'invalid JSON'));
        return feedback();
      },
    },
    restoreWrites(prefix),
  );
  assert.deepEqual(await restored.runtime.resume(prefix[0].image.frame.owner.contextId, {}), answer);
  assert.equal(requests, 1, 'the handled first failure is historical; only the explicitly authorized second candidate is new');

  const changed = structuredClone(prefix);
  changed.at(-1).image.state.error.code = 'EMPTY_OUTPUT';
  const invalid = harness(t, () => assert.fail('changed retry evidence cannot start a model'), restoreWrites(changed));
  await assert.rejects(invalid.runtime.resume(prefix[0].image.frame.owner.contextId, {}), /rejection/i);
});
