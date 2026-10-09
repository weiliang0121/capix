import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindResources, ResourceOffer, TranscriptResource, TranscriptRangeRef, Transcript, Memories, MemoryResource, ChangeObserver, Recorder, RecordBook, RuntimeRecordHelper, ExecutionRecordHelper, ResourceRecord, RecordingError, snapshotValue } from '@capix-observer/runtime';

function scope(recorder = new Recorder(new RecordBook()), contextId = 'call') {
  const runtime = RuntimeRecordHelper.create(recorder);
  const record = ExecutionRecordHelper.create(recorder, { contextId, parentId: runtime.id }, { input: null });
  return {
    recorder,
    record,
    owner: {
      contextId,
      validate: () => {
        if (record.status !== 'running') throw new Error('Call has ended');
      },
      source: () => ({ contextId, callId: record.id, executionId: record.id }),
      recording: { recorder, parentId: () => record.id },
    },
  };
}
function facts(recorder) {
  return [...recorder.book.values()].filter((record) => record instanceof ResourceRecord);
}

test('resource static assembly records nothing, binding captures once, per-call facts contain plain frozen values', () => {
  const { recorder, record, owner } = scope();
  let captures = 0;
  let descriptions = 0;
  const settings = new ResourceOffer('settings.snapshot', (source) => source, 'binding', {
    capture: (source) => {
      captures++;
      return Object.freeze({ ...source });
    },
    describe: (source) => {
      descriptions++;
      return source;
    },
  });
  const configure = bindResources({ settings: settings.request() }, [settings.provide((source) => source)]);
  assert.equal(captures, 0);
  const source = { limit: 100 };
  const bound = configure(source);
  source.limit = 200;
  assert.equal(captures, 1);
  assert.equal(facts(recorder).length, 0);
  bound.attach(owner);
  assert.throws(() => bound.values.settings, /started invocation/);
  bound.start();
  assert.equal(bound.values.settings.limit, 100);
  assert.equal(descriptions, 1);
  const recorded = facts(recorder);
  assert.deepEqual(
    recorded.map((fact) => fact.phase),
    ['bound', 'available'],
  );
  assert.deepEqual(
    recorded.map((fact) => fact.sequence),
    [1, 2],
  );
  assert.ok(recorded.every((fact) => fact.parentId === record.id));
  assert.deepEqual(recorded[1].value, { limit: 100 });
  assert.ok(Object.isFrozen(recorded[1].value));
  assert.deepEqual(
    ExecutionRecordHelper.snapshot(recorder, record.id).resources,
    recorded.map((fact) => fact.toJSON()),
  );
  assert.throws(() => bound.attach(owner), /already established/);
});

test('shared lazy supplies create one provider but give separate calls separately attributed endpoints', async () => {
  let captures = 0;
  const model = new ResourceOffer('model.invoke', (provider, activity) => Object.freeze({ invoke: (value) => activity.runAsync('invoke', { input: () => value, output: (result) => result }, () => provider.invoke(value)) }), 'access', { describe: () => ({ provider: 'fixture' }) });
  const bind = bindResources({ model: model.request() }, [
    model.provide(() => {
      captures++;
      return {
        async invoke(value) {
          return `${value}!`;
        },
      };
    }),
  ]);
  const parent = bind(null);
  const child = parent.select({ action: model.request() });
  const first = scope(undefined, 'first');
  const second = scope(first.recorder, 'second');
  parent.attach(first.owner);
  child.attach(second.owner);
  parent.start();
  child.start();
  assert.equal(captures, 0);
  assert.deepEqual(
    facts(first.recorder).map((fact) => fact.phase),
    ['bound', 'bound'],
  );
  const one = parent.values.model;
  const two = child.values.action;
  assert.notEqual(one, two);
  assert.equal(captures, 1);
  assert.deepEqual(await Promise.all([one.invoke('a'), two.invoke('b')]), ['a!', 'b!']);
  const recorded = facts(first.recorder);
  assert.equal(new Set(recorded.map((fact) => fact.supplyId)).size, 1);
  for (const current of [first, second]) {
    const local = recorded.filter((fact) => fact.parentId === current.record.id);
    assert.deepEqual(
      local.map((fact) => fact.phase),
      ['bound', 'available', 'started', 'returned'],
    );
    assert.deepEqual(
      local.map((fact) => fact.sequence),
      [1, 2, 3, 4],
    );
    assert.equal(local[2].interactionId, local[3].interactionId);
  }
});

test('without recording, resource descriptors and operation summaries are not evaluated', async () => {
  const fail = () => assert.fail('description must not run');
  const offer = new ResourceOffer('plain', (source, activity) => ({ sync: () => activity.runSync('sync', { input: fail, output: fail }, () => source), async: () => activity.runAsync('async', { input: fail, output: fail }, async () => source) }), 'binding', { describe: fail });
  const bound = bindResources({ value: offer.request() }, [offer.provide(() => 12)])(null);
  bound.attach({ contextId: 'no-record', validate: () => {}, source: () => undefined });
  bound.start();
  assert.equal(bound.values.value.sync(), 12);
  assert.equal(await bound.values.value.async(), 12);
});

test('fixed history recording stores stable locator only while endpoint reads immutable messages', () => {
  const source = new Transcript([{ role: 'user', content: 'first' }]);
  const range = new TranscriptRangeRef(source, 0, 1);
  const bound = bindResources({ history: TranscriptResource.fixedRange.request() }, [TranscriptResource.fixedRange.provide(() => range)])(null);
  const { recorder, owner } = scope();
  bound.attach(owner);
  source.append({ role: 'assistant', content: 'later' });
  bound.start();
  assert.deepEqual(facts(recorder)[1].value, { transcriptId: source.id, start: 0, end: 1, revision: 1 });
  assert.equal(bound.values.history.read(0), source.get(0));
  assert.equal(bound.values.history.end, 1);
  assert.throws(() => bound.values.history.read(1), /outside/);
  assert.ok(facts(recorder).every((fact) => !JSON.stringify(fact).includes('first')));
  assert.throws(() => snapshotValue(range), /plain objects/);
  assert.throws(() => snapshotValue(source.ref(0)), /plain objects/);
});

test('content origins exist with no recorder and child writer endpoints do not retain the parent origin', () => {
  const changes = new ChangeObserver();
  const transcript = new Transcript([], { changes });
  const memories = new Memories(transcript, { changes });
  const bound = bindResources({ messages: TranscriptResource.append.request(), memory: MemoryResource.apply.request() }, [TranscriptResource.append.provide(() => transcript), MemoryResource.apply.provide(() => memories)])(null);
  const child = bound.select({ messages: TranscriptResource.append.request(), memory: MemoryResource.apply.request() });
  bound.attach({ contextId: 'parent', validate: () => {}, source: () => undefined });
  child.attach({ contextId: 'child', validate: () => {}, source: () => undefined });
  bound.start();
  child.start();
  bound.values.messages.append([{ role: 'user', content: 'parent' }]);
  child.values.messages.append([{ role: 'assistant', content: 'child' }]);
  child.values.memory.apply([{ action: 'create', memoryId: null, change: 'added', sourceIndexes: [1], result: { topic: 'topic', content: 'content', sourceIndexes: [1] } }]);
  const events = changes.take();
  assert.deepEqual(
    events.map((event) => event.origin),
    [{ contextId: 'parent' }, { contextId: 'child' }, { contextId: 'child' }],
  );
  assert.ok(events.every((event) => !Object.hasOwn(event, 'source')));
});

test('resource access facts and content changes use the same call ownership without copying message bodies', () => {
  const { recorder, record, owner } = scope();
  const transcript = new Transcript([], { recorder });
  const bound = bindResources({ messages: TranscriptResource.append.request() }, [TranscriptResource.append.provide(() => transcript)])(null);
  bound.attach(owner);
  bound.start();
  bound.values.messages.append([{ role: 'user', content: 'large body' }]);
  const content = recorder.tree.children(record.id).find((item) => item.kind === 'transcript');
  assert.equal(content.parentId, record.id);
  assert.deepEqual(content.value, { action: 'append', start: 0, end: 1 });
  assert.equal(content.contextId, owner.contextId);
  assert.ok(facts(recorder).every((fact) => fact.parentId === record.id));
});

for (const phase of ['started', 'returned', 'threw'])
  test(`strict resource ${phase} registration failure preserves exact execution count and errors`, async () => {
    class RejectingRecorder extends Recorder {
      add(record) {
        if (record.kind === 'resource' && record.phase === phase) throw new Error(`reject ${phase}`);
        return super.add(record);
      }
    }
    const { recorder, owner } = scope(new RejectingRecorder(new RecordBook()));
    let executions = 0;
    const cause = new Error('operation failure');
    const action = new ResourceOffer(
      'action',
      (_source, activity) => () =>
        activity.runAsync('operate', {}, async () => {
          executions++;
          if (phase === 'threw') throw cause;
          return 'committed';
        }),
    );
    const bound = bindResources({ action: action.request() }, [action.provide(() => null)])(null);
    bound.attach(owner);
    bound.start();
    await assert.rejects(bound.values.action(), (error) => {
      if (phase === 'threw') {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], cause);
        assert.ok(error.errors[1] instanceof RecordingError);
      } else assert.ok(error instanceof RecordingError);
      return true;
    });
    assert.equal(executions, phase === 'started' ? 0 : 1);
    assert.equal(facts(recorder).filter((fact) => fact.phase === 'threw').length, 0);
  });

test('failed lazy supply is cached and recorded for each actual call without reinitializing', () => {
  let attempts = 0;
  const cause = new Error('supply unavailable');
  const offer = new ResourceOffer('lazy', (source) => source);
  const first = bindResources({ value: offer.request() }, [
    offer.provide(() => {
      attempts++;
      throw cause;
    }),
  ])(null);
  const second = first.select({ value: offer.request() });
  const one = scope(undefined, 'one');
  const two = scope(one.recorder, 'two');
  first.attach(one.owner);
  second.attach(two.owner);
  first.start();
  second.start();
  assert.throws(
    () => first.values.value,
    (error) => error === cause,
  );
  assert.throws(
    () => second.values.value,
    (error) => error === cause,
  );
  assert.equal(attempts, 1);
  assert.equal(facts(one.recorder).filter((fact) => fact.phase === 'unavailable').length, 2);
});

test('retained writer endpoint cannot mutate after a call ends even without recording', () => {
  const transcript = new Transcript();
  const bound = bindResources({ messages: TranscriptResource.append.request() }, [TranscriptResource.append.provide(() => transcript)])(null);
  let active = true;
  bound.attach({
    contextId: 'call',
    source: () => undefined,
    validate: () => {
      if (!active) throw new Error('Call has ended');
    },
  });
  bound.start();
  const endpoint = bound.values.messages;
  endpoint.append([{ role: 'user', content: 'accepted' }]);
  active = false;
  assert.throws(() => endpoint.append([{ role: 'assistant', content: 'late' }]), /ended/);
  assert.throws(() => bound.values.messages, /ended/);
  assert.equal(transcript.length, 1);
});

test('resource access names cannot ambiguously identify different offers in the same binding', () => {
  const first = new ResourceOffer('same', (value) => value);
  const second = new ResourceOffer('same', (value) => value);
  assert.throws(() => bindResources({ one: first.request(), two: second.request() }, [first.provide(() => 1), second.provide(() => 2)]), /same access name/);
  const bindings = bindResources({ one: first.request(), alias: first.request() }, [first.provide(() => 1)])(null);
  assert.equal(bindings.values.one, bindings.values.alias);
});

test('entry-window restriction guards retained endpoints and readers without inventing a call origin', () => {
  const changes = new ChangeObserver();
  const transcript = new Transcript(
    [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ],
    { changes },
  );
  changes.take();
  const bindings = bindResources({ writer: TranscriptResource.append.request(), segment: TranscriptResource.segmentation.request() }, [TranscriptResource.append.provide(() => transcript), TranscriptResource.segmentation.provide(() => transcript)])(null);
  let active = true;
  bindings.restrict(() => {
    if (!active) throw new Error('Entry is closed');
  });
  const writer = bindings.values.writer;
  const segment = bindings.values.segment;
  const reader = segment.current();
  writer.append([{ role: 'user', content: 'three' }]);
  assert.equal(changes.take()[0].origin, undefined);
  active = false;
  assert.throws(() => writer.append([{ role: 'assistant', content: 'late' }]), /closed/);
  assert.throws(() => segment.current(), /closed/);
  assert.throws(() => reader.read(0), /closed/);
  assert.throws(() => reader.slice(0), /closed/);
  assert.equal(transcript.length, 3);
});
