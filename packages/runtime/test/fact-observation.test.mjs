import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactType, publishFact } from '@weiliang0121/capix-changes';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { BaseRecord, RecordBook, Recorder, recordContentFact } from '@weiliang0121/capix-records';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Scene, Resources, Runner, bindRecording } from '@weiliang0121/capix-runtime';

const changed = new FactType('business.changed');
const codec = { encode: structuredClone, decode: structuredClone };
class BusinessRecord extends BaseRecord {}

function businessOffer() {
  return new ResourceOffer({
    name: 'business',
    methods: {
      async change(origin, input, operation) {
        await input.gate;
        origin.values.push(input.value);
        publishFact({ value: input.value }, undefined, operation.facts(changed));
        if (input.fail) throw new Error('method failed after applying change');
        return input.value;
      },
    },
  });
}

function makeRunner(run, observations = []) {
  const entity = { values: [] };
  const offer = businessOffer();
  const scene = new Scene({ deps: { entity: offer.request() }, run });
  const runner = new Runner(scene, new Resources().register(new Resource(entity), offer), undefined, { observations }).build();
  return { runner, entity };
}

const observer = (fact, failure = 'propagate') => ({ failure, bindInvocation: () => ({ observe() {}, fact }) });

test('new business facts retain their exact overlapping operation and reach Runner as metadata only', async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const received = [];
  const events = [];
  const { runner, entity } = makeRunner(
    async (work) => {
      const a = work.resources.entity.change({ value: 'PRIVATE_FIRST', gate: first.promise });
      const b = work.resources.entity.change({ value: 'PRIVATE_SECOND', gate: second.promise });
      second.resolve();
      assert.equal(await b, 'PRIVATE_SECOND');
      first.resolve();
      assert.equal(await a, 'PRIVATE_FIRST');
      return null;
    },
    [observer((fact) => changed.match(fact.fact, (body) => received.push({ fact, body })))],
  );
  runner.observation.subscribe({ receive: (event) => void events.push(event) });
  assert.equal(await runner.run(null), null);
  assert.deepEqual(entity.values, ['PRIVATE_SECOND', 'PRIVATE_FIRST']);
  assert.deepEqual(
    received.map(({ body }) => body.value),
    entity.values,
  );
  assert.notEqual(received[0].fact.operationId, received[1].fact.operationId);
  const starts = events.filter((event) => event.source === 'resource' && event.fact.phase === 'started');
  const facts = events.filter((event) => event.source === 'fact');
  assert.equal(facts.length, 2);
  assert.equal(facts[0].fact.operationId, starts[1].fact.interactionId);
  assert.equal(facts[1].fact.operationId, starts[0].fact.interactionId);
  assert.ok(facts.every((event) => event.fact.name === 'business.changed' && Object.isFrozen(event.fact)));
  assert.ok(facts.every((event) => !('fact' in event.fact)));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_FIRST|PRIVATE_SECOND/);
});

test('an applied business fact survives its method failure and a reusable record adapter keeps its call parent', async () => {
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder, {
    failure: 'propagate',
    fact(fact, source, writer) {
      recordContentFact(fact, source, writer);
      changed.match(fact.fact, (body) => writer.add(new BusinessRecord({ value: body.value, contextId: source.contextId, operationId: fact.operationId }, source.callId)));
    },
  });
  const { runner, entity } = makeRunner((work) => work.resources.entity.change({ value: 'committed', fail: true }), [recording]);
  await assert.rejects(runner.run(null), /method failed/);
  assert.deepEqual(entity.values, ['committed']);
  const records = [...recorder.book.values()];
  const record = records.find((item) => item instanceof BusinessRecord);
  const call = recorder.book.get(record.parentId);
  assert.equal(record.value.contextId, call.contextId);
  assert.equal(call.status, 'failed');
  const operation = records.find((item) => item.kind === 'resource' && item.phase === 'started');
  assert.equal(record.value.operationId, operation.interactionId);
});

for (const failure of ['isolate', 'propagate']) {
  test(`a ${failure} fact consumer stops once while a healthy peer receives the applied fact`, async () => {
    let broken = 0;
    let healthy = 0;
    let fallback = 0;
    const { runner, entity } = makeRunner(
      async (work) => {
        await work.resources.entity.change({ value: 'first' }, { result: { failed: () => ++fallback } });
        return work.resources.entity.change({ value: 'second' });
      },
      [
        observer(() => {
          broken++;
          throw new Error('fact consumer failed');
        }, failure),
        observer(() => {
          healthy++;
        }),
      ],
    );
    if (failure === 'propagate') await assert.rejects(runner.run(null));
    else assert.equal(await runner.run(null), 'second');
    assert.equal(broken, 1);
    assert.equal(healthy, failure === 'propagate' ? 1 : 2);
    assert.equal(fallback, 0);
    assert.deepEqual(entity.values, failure === 'propagate' ? ['first'] : ['first', 'second']);
  });
}

for (const failure of ['isolate', 'propagate']) {
  test(`an asynchronous recording fact adapter is rejected under ${failure} policy`, async () => {
    const invalidated = [];
    let adapters = 0;
    const recording = bindRecording(new Recorder(new RecordBook()), {
      failure,
      invalidate: (error) => invalidated.push(error),
      fact: async () => {
        adapters++;
        throw new Error('async adapter rejection');
      },
    });
    const { runner, entity } = makeRunner((work) => work.resources.entity.change({ value: 'committed' }), [recording]);
    if (failure === 'propagate') await assert.rejects(runner.run(null));
    else assert.equal(await runner.run(null), 'committed');
    assert.equal(adapters, 1);
    assert.ok(invalidated.some((error) => /synchronous/.test(error.message)));
    assert.deepEqual(entity.values, ['committed']);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

for (const failure of ['isolate', 'propagate']) {
  test(`recovery forwards generic facts and preserves ${failure} checkpoint failures without exposing bodies`, async () => {
    const store = new MemoryCheckpointStore();
    const entity = { values: [] };
    const offer = businessOffer();
    const point = { name: 'saved', state: codec, references: {}, resume: { deps: { entity: offer.request() }, run: (work) => work.resources.entity.change({ value: 'PRIVATE_RECOVERY_BODY' }) } };
    const scene = new Scene({
      deps: { entity: offer.request() },
      run: () => assert.fail('recovery cannot replay normal work'),
      checkpoint: { key: 'generic-fact-recovery', version: 1, input: codec, output: codec, points: [point] },
    });
    const contextId = 'generic-fact-recovery';
    store.save(
      {
        id: 'saved',
        formatVersion: 6,
        contract: { key: 'generic-fact-recovery', version: 1 },
        point: 'saved',
        frame: { owner: { contextId, kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] },
        state: null,
        references: {},
      },
      0,
    );
    const actual = [];
    const events = [];
    const runner = new Runner(scene, new Resources().register(new Resource(entity), offer), undefined, {
      checkpoints: {
        store,
        observation: {
          failure,
          observe(fact) {
            actual.push(fact);
            if (fact.kind === 'fact') throw new Error('checkpoint fact observer failed');
          },
        },
      },
    }).build();
    runner.observation.subscribe({ receive: (event) => void events.push(event) });
    if (failure === 'propagate') await assert.rejects(runner.resume(contextId));
    else assert.equal(await runner.resume(contextId), 'PRIVATE_RECOVERY_BODY');
    const fact = actual.find((item) => item.kind === 'fact');
    assert.equal(fact.recovering, true);
    assert.equal(fact.fact.contextId, contextId);
    assert.equal(
      changed.match(fact.fact.fact, (body) => assert.equal(body.value, 'PRIVATE_RECOVERY_BODY')),
      true,
    );
    const projected = events.find((event) => event.source === 'checkpoint' && event.fact.kind === 'fact');
    assert.equal(projected.fact.fact.operationId, fact.fact.operationId);
    assert.equal(projected.fact.fact.name, 'business.changed');
    assert.ok(!('fact' in projected.fact.fact));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RECOVERY_BODY/);
    assert.ok(events.some((event) => event.source === 'checkpoint' && event.fact.kind === 'finished'));
    assert.equal(store.read(contextId).delivery.status, failure === 'propagate' ? 'failed' : 'succeeded');
  });
}
