import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactType, publishFact } from '@weiliang0121/capix-changes';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Scene, Runner, Resources, bindRecording } from '@weiliang0121/capix-runtime';
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
  const runner = new Runner(scene, new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource(null), business), undefined, {
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
