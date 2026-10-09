import { createEnvironment } from './fixtures/environment.mjs';
import { resourceBindingFor, bindChild } from './fixtures/observer.mjs';
import { Execution, Operation, Attempt } from './fixtures/behavior.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindResources, ResourceOffer, TranscriptResource, Transcript, TranscriptRangeRef, Memories, SelectionUsage, checkResourceRequests, Sequence, createRuntime } from '@capix-observer/runtime';
import { bindObserver, ObserverRuntimeDefinition, GenerateAnswer } from '@capix-observer/service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };

function provider() {
  return {
    async invoke(_request, purpose) {
      const value = purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: '回答' } : { memories: [] };
      return { id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null };
    },
  };
}

test('Observer narrows resources at each action, captures fixed values and expires live endpoints with the call', async () => {
  const entities = createEnvironment();
  const definition = new ObserverRuntimeDefinition();
  const views = [];
  const inspect = (current) => {
    const execute = current.run.execute;
    current.run.execute = function (context, ...args) {
      views.push({ definition: current, resources: { ...context.resources.values } });
      return execute.call(this, context, ...args);
    };
    for (const child of current.children ?? []) inspect(child);
  };
  inspect(definition.execution);
  const runtime = bindObserver(definition, entities, provider());
  let first;
  await runtime.run(
    { messages: [{ role: 'user', content: '你好' }] },
    { settings },
    {
      started: (_context, invocation) => {
        first = invocation;
      },
    },
  );
  const firstViews = [...views];
  const entry = firstViews[0].resources;
  const selection = firstViews[1].resources;
  assert.equal(entry.history.locate().end, 1);
  assert.equal(selection.history.locate().end, 1);
  assert.notEqual(entry.history, selection.history);
  assert.equal(selection.history.transcript, undefined);
  assert.equal(selection.settings, entry.settings);
  assert.equal(selection.timeoutMs, 1000);
  assert.throws(() => entry.history.read(0), /running|ended/i);
  assert.equal(first.record, undefined);
  assert.ok(first.children.values().length === 3);
  views.length = 0;
  await runtime.run({ messages: [{ role: 'user', content: '继续' }] }, { settings: { ...settings, timeoutMs: 2000 } });
  assert.equal(views[0].resources.history.end, 3);
  assert.equal(views[0].resources.timeoutMs, 2000);
  assert.equal(entry.timeoutMs, 1000);
  assert.equal(entry.history.end, 1);
  assert.notEqual(views[0].resources.settings, entry.settings);
});

test('nested operations cannot implicitly bypass their direct parent for execution resources', async () => {
  const runtime = createRuntime();
  const generation = bindChild(runtime, new GenerateAnswer());
  let wrapper;
  class NarrowOperation extends Operation {
    name = 'narrow';
    label = 'narrow';
    source = 'test';
    execute(_context, invocation) {
      wrapper = invocation;
      return generation.call(invocation, { selection: { historyIndexes: [] }, memories: [] });
    }
  }
  const operation = new NarrowOperation(runtime.operationInvocations);
  class Entry extends Execution {
    execute(_context, invocation) {
      return operation.call(invocation, null);
    }
  }
  await assert.rejects(new Entry(runtime.executionInvocations).call(null, { settings }), /Unfulfilled resource request: model-settings.snapshot/);
  assert.equal(wrapper.children.values().length, 0);
});

test('a leaf missing its declared resource fails before attaching a child invocation', async () => {
  const runtime = createRuntime();
  let parent;
  class Leaf extends Attempt {
    name = 'leaf';
    label = 'leaf';
    source = 'test';
    callee = 'test';
    execute() {
      throw new Error('must not execute');
    }
  }
  const leaf = new Leaf(runtime.attemptInvocations, { history: TranscriptResource.fixedRange.request() });
  class Parent extends Operation {
    name = 'parent';
    label = 'parent';
    source = 'test';
    execute(_context, invocation) {
      parent = invocation;
      return leaf.call(invocation, null);
    }
  }
  const operation = new Parent(runtime.operationInvocations);
  class Entry extends Execution {
    execute(_context, invocation) {
      return operation.call(invocation, null);
    }
  }
  await assert.rejects(new Entry(runtime.executionInvocations).call(null, { settings }), /Unfulfilled resource request: transcript.fixedRange/);
  assert.equal(parent.children.values().length, 0);
});

test('requests select published offer identity, not a matching name or local alias', () => {
  const offered = new ResourceOffer('messages.read', (source) => Object.freeze({ read: () => source.text }));
  const unrelated = new ResourceOffer('messages.read', (source) => source);
  const providers = [offered.provide((parent) => parent)];
  assert.throws(() => bindResources({ history: unrelated.request() }, providers), /received 0/);
  const bound = bindResources({ history: offered.request() }, providers)({ text: 'hello' });
  const child = bound.select({ messages: offered.request() });
  assert.notEqual(child.values.messages, bound.values.history);
  assert.equal(child.values.messages.read(), 'hello');
  assert.throws(() => bound.select({ history: unrelated.request() }), /Unfulfilled resource request/);
});

test('assembly validates requests without resolving sources, and rejects duplicate providers', () => {
  let resolved = false;
  const offer = new ResourceOffer('source', (source) => source);
  const other = new ResourceOffer('other', (source) => source);
  const provider = offer.provide(() => {
    resolved = true;
    return {};
  });
  assert.throws(() => bindResources({ value: other.request() }, [provider]), /received 0/);
  assert.throws(() => bindResources({ value: offer.request() }, [provider, provider]), /received 2/);
  const bind = bindResources({ value: offer.request() }, [provider]);
  assert.equal(resolved, false);
  assert.deepEqual(bind(null).values.value, {});
  assert.equal(resolved, true);
});

test('publication supplies the access form; construction only binds the source and captures requests', () => {
  const offer = new ResourceOffer('read', (source) => Object.freeze({ read: () => source.text }));
  const unused = new ResourceOffer('unused', (source) => source);
  const requires = { reader: offer.request() };
  const bind = bindResources(requires, [
    offer.provide((parent) => parent),
    unused.provide(() => {
      throw new Error('unused');
    }),
  ]);
  requires.reader = unused.request();
  const source = { text: 'first' };
  const first = bind(source);
  const second = bind({ text: 'second' });
  assert.deepEqual(Object.keys(first.values.reader), ['read']);
  assert.ok(Object.isFrozen(first.values));
  assert.equal(first.values.reader.read(), 'first');
  source.text = 'updated';
  assert.equal(first.values.reader.read(), 'updated');
  assert.equal(second.values.reader.read(), 'second');
});

test('sequence preserves distinct offers even when children use the same alias', () => {
  const one = new ResourceOffer('one', (source) => source);
  const two = new ResourceOffer('two', (source) => source);
  const create = () => {
    throw new Error('must not execute during assembly');
  };
  const first = { requires: { value: one.request() }, create };
  const second = { requires: { value: two.request() }, create };
  const sequence = new Sequence().step('first', { use: first, input: () => null }).step('second', { use: second, input: () => null });
  assert.equal(sequence.steps[0].use, first);
  assert.equal(sequence.steps[1].use, second);
  assert.equal(sequence.requests.length, 2);
  assert.throws(() => checkResourceRequests({ value: one.request() }, sequence.requests), /not provided: two/);
  checkResourceRequests({ first: one.request(), second: two.request() }, sequence.requests);
});

test('fixed-range offer delivers only bounded immutable message access, without exposing the entity', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'outside' },
    { role: 'user', content: 'inside' },
  ]);
  const range = new TranscriptRangeRef(transcript, 1, 2);
  const bind = bindResources({ history: TranscriptResource.fixedRange.request() }, [TranscriptResource.fixedRange.provide((parent) => parent)]);
  const reader = bind(range).values.history;
  assert.equal(reader.read(1), transcript.get(1));
  assert.equal(reader.transcript, undefined);
  assert.equal(reader.ref, undefined);
  assert.equal(reader.append, undefined);
  assert.equal(reader.slice(1, 2).read(1), transcript.get(1));
  assert.throws(() => reader.slice(0, 2), RangeError);
  assert.throws(() => reader.slice(1, 3), RangeError);
  assert.throws(() => reader.read(0), RangeError);
  transcript.append({ role: 'assistant', content: 'later' });
  assert.equal(reader.end, 2);
  assert.throws(() => reader.read(2), RangeError);
  const entries = reader.entries();
  assert.deepEqual(
    entries.map((entry) => entry.index),
    [1],
  );
  assert.ok(Object.isFrozen(entries));
  assert.ok(Object.isFrozen(entries[0].message));
});

test('root requests must be fulfilled before started, recording or business work', async () => {
  const { Recorder, RecordBook } = await import('@capix-observer/runtime');
  const recorder = new Recorder(new RecordBook());
  const runtime = createRuntime({ recorder });
  const before = [...recorder.book.values()];
  class Entry extends Execution {
    requires = { history: TranscriptResource.fixedRange.request() };
    execute() {
      assert.fail('must not execute');
    }
  }
  await assert.rejects(
    new Entry(runtime.executionInvocations).call(null, { settings }, () => assert.fail('must not start')),
    /Unfulfilled resource request: transcript.fixedRange/,
  );
  assert.equal(runtime.running, false);
  assert.deepEqual([...recorder.book.values()], before);
});

test('message and memory access preserves entity validation, change publication and fixed snapshots', async () => {
  const { MemoryResource, SelectionUsageResource, Recorder, RecordBook, ChangeObserver } = await import('@capix-observer/runtime');
  const recorder = new Recorder(new RecordBook());
  const changes = new ChangeObserver();
  const { transcript, memories, selectionUsage } = createEnvironment({ recorder, changes });
  const bind = bindResources(
    {
      messages: TranscriptResource.append.request(),
      memories: MemoryResource.snapshot.request(),
      writer: MemoryResource.apply.request(),
      usage: SelectionUsageResource.record.request(),
    },
    [TranscriptResource.append.provide(() => transcript), MemoryResource.snapshot.provide(() => memories), MemoryResource.apply.provide(() => memories), SelectionUsageResource.record.provide(() => selectionUsage)],
  );
  const before = bind(null).values;
  changes.take();
  const recordCount = [...recorder.book.values()].length;
  assert.deepEqual(Object.keys(before.messages), ['append']);
  assert.deepEqual(Object.keys(before.writer), ['apply']);
  assert.deepEqual(Object.keys(before.usage), ['add']);
  assert.throws(
    () =>
      before.messages.append([
        { role: 'user', content: 'valid' },
        { role: 'user', content: '' },
      ]),
    /非空/,
  );
  assert.equal(transcript.length, 0);
  assert.equal(changes.take().length, 0);
  const appended = before.messages.append([{ role: 'user', content: '培训周五' }]);
  assert.deepEqual(Object.keys(appended[0]).sort(), ['index', 'message']);
  assert.equal(appended[0].message, transcript.get(0));
  assert.ok(Object.isFrozen(appended[0]));
  const change = { action: 'create', memoryId: null, change: '确认时间', sourceIndexes: [0], result: { topic: '培训', content: '周五', sourceIndexes: [0] } };
  before.writer.apply([change]);
  const captured = changes.take();
  assert.equal(captured.filter((event) => event.type === 'transcript').length, 1);
  assert.equal(captured.filter((event) => event.type === 'memory').length, 1);
  assert.equal([...recorder.book.values()].length - recordCount, 2);
  assert.deepEqual(before.memories, []);
  const later = bind(null).values;
  assert.ok(Object.isFrozen(later.memories));
  assert.ok(Object.isFrozen(later.memories[0]));
  assert.ok(Object.isFrozen(later.memories[0].sourceIndexes));
  assert.equal(later.memories[0].transcript, undefined);
  assert.equal(later.writer.apply([{ ...change, action: 'update', memoryId: later.memories[0].id, result: { ...change.result, content: '周六' } }]), undefined);
  assert.equal(later.memories[0].content, '周五');
  assert.equal(bind(null).values.memories[0].content, '周六');
  later.usage.add([appended[0].message, appended[0].message]);
  assert.equal(selectionUsage.get(appended[0].message), 1);
});

test('model offer exposes only invocation while preserving provider method ownership', async () => {
  const entities = createEnvironment();
  const model = { ...provider(), privateValue: 'provider-only' };
  const invoke = model.invoke;
  model.invoke = function (...args) {
    assert.equal(this, model);
    return invoke(...args);
  };
  const definition = new ObserverRuntimeDefinition();
  const execute = definition.execution.run.execute;
  definition.execution.run.execute = function (context, ...args) {
    const access = context.resources.values.model;
    assert.notEqual(access, model);
    assert.deepEqual(Object.keys(access), ['invoke']);
    assert.equal(access.privateValue, undefined);
    assert.ok(Object.isFrozen(access));
    assert.equal(context.settings, undefined);
    assert.equal(context.transcriptRange, undefined);
    return execute.call(this, context, ...args);
  };
  const runtime = bindObserver(definition, entities, model);
  await runtime.run({ messages: [{ role: 'user', content: '你好' }] }, { settings });
});
