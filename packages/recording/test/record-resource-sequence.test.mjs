import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactType, publishFact } from '@weiliang0121/capix-changes';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Scene, Group, Node, Runner, Resources } from '@weiliang0121/capix-runtime';
import { bindRecording } from '@weiliang0121/capix-recording';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';
import { CallableRecordHelper, RecordBook, Recorder } from '@weiliang0121/capix-records';
import { readOutput, validateExecutionRecordSnapshot } from '@weiliang0121/capix-records/data';

test('real resource observations and domain facts share sequence while record projections and restore retain valid gaps', async () => {
  const transcript = new Transcript();
  const recorder = new Recorder(new RecordBook());
  const businessFacts = new FactType('record-sequence-business');
  const business = new ResourceOffer({
    name: 'business.write',
    methods: {
      write(_origin, input, operation) {
        publishFact({ content: input }, undefined, operation.facts(businessFacts));
        return input;
      },
    },
  });
  const scene = new Scene({
    deps: { messages: TranscriptResource.append.request(), business: business.request() },
    async run(work) {
      work.resources.messages.append([{ role: 'user', content: work.input }]);
      return work.resources.business.write(work.input);
    },
  });
  const observed = [];
  const runner = new Runner(scene, new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource(null), business), {
    observations: [
      bindRecording(recorder, { failure: 'propagate' }),
      {
        failure: 'propagate',
        bindInvocation: () => ({ observe() {}, resource: (fact) => observed.push({ kind: 'resource', fact }), fact: (fact) => observed.push({ kind: 'domain', fact }) }),
      },
    ],
  }).build();
  assert.equal(await runner.run('recorded'), 'recorded');
  assert.deepEqual(
    observed.map(({ fact }) => fact.sequence),
    observed.map((_, index) => index + 1),
  );
  const facts = observed.filter(({ kind }) => kind === 'domain');
  assert.equal(facts.length, 2);
  assert.equal(
    businessFacts.match(facts[1].fact.fact, (body) => assert.equal(body.content, 'recorded')),
    true,
  );
  const call = [...recorder.book.values()].find((record) => record.kind === 'invocation');
  const snapshot = CallableRecordHelper.snapshot(recorder, call.id);
  assert.deepEqual(
    snapshot.resources.map((record) => record.sequence),
    observed.filter(({ kind }) => kind === 'resource').map(({ fact }) => fact.sequence),
  );
  for (const { fact } of facts)
    assert.equal(
      snapshot.resources.some((record) => record.sequence === fact.sequence),
      false,
    );
  assert.equal(snapshot.transcripts.length, 1);
  validateExecutionRecordSnapshot(snapshot);
  assert.equal(readOutput(snapshot.execution.value), 'recorded');
  const saved = JSON.parse(JSON.stringify(recorder.book.exportState()));
  const restored = new Recorder(RecordBook.restore(saved));
  const restoredSnapshot = CallableRecordHelper.snapshot(restored, call.id);
  validateExecutionRecordSnapshot(restoredSnapshot);
  assert.deepEqual(restoredSnapshot, snapshot);
  const invalid = structuredClone(saved);
  const resources = invalid.entries.filter((entry) => entry.kind === 'resource');
  resources.at(-1).data.sequence = resources.at(-2).data.sequence;
  assert.throws(() => RecordBook.restore(invalid), /resource sequence/);
});

test('a refined supply records bound and available under the precise consuming call', async () => {
  const offer = new ResourceOffer({
    name: 'restricted',
    timing: 'access',
    expose: (limit) => limit,
    refine: (limit, selected) => Math.min(limit, selected),
    describe: (limit) => ({ limit }),
  });
  const deps = { limit: offer.request() };
  const leaf = new Node({ deps, run: (work) => work.resources.limit });
  const group = new Group({ deps, run: async (work) => [work.resources.limit, await work.children.invoke(leaf, 1)] }).add(leaf);
  const scene = new Scene({ deps, run: async (work) => [work.resources.limit, ...(await work.children.invoke(group, 2))] }).add(group);
  const resources = new Resources()
    .register(offer, 3)
    .refine(
      group,
      offer.refine((value) => value),
    )
    .refine(
      leaf,
      offer.refine((value) => value),
    );
  const recorder = new Recorder(new RecordBook());
  assert.deepEqual(await new Runner(scene, resources, { observations: [bindRecording(recorder, { failure: 'propagate' })] }).build().run(null), [3, 2, 1]);
  const records = [...recorder.book.values()].filter((record) => record.kind === 'resource' && record.access === 'restricted');
  const available = records.filter((record) => record.phase === 'available');
  assert.deepEqual(
    available.map((record) => record.value.limit),
    [3, 2, 1],
  );
  assert.deepEqual(
    available.map((record) => recorder.book.get(record.parentId).structureId),
    [scene.id, group.id, leaf.id],
  );
  assert.equal(new Set(available.map((record) => record.supplyId)).size, 3);
  for (const record of available) assert.ok(records.some((candidate) => candidate.phase === 'bound' && candidate.supplyId === record.supplyId && candidate.parentId === record.parentId));
});
