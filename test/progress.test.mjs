import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, ProgressChannel, Transcript, TranscriptResource, bindResources, ExecutionDefinition, assembleRuntime } from '@capix/server-runtime';
import { runtimeDefinition } from './fixtures/declarations.mjs';

const message = (content) => ({ role: 'user', content });
const invocation = (options = {}) => new Invocation({ context: new InvocationContext('input'), work: { maxRounds: 1, execute: () => 'answer' }, signal: new AbortController().signal, ...options });

test('passive progress does not expose Context and receiver faults never change the call result', async () => {
  const error = new Error('projection unavailable');
  let notifications = 0;
  let reported;
  const call = invocation({
    progress: {
      receive(fact) {
        notifications++;
        assert.deepEqual(Object.keys(fact), ['kind', 'identity']);
        assert.ok(Object.isFrozen(fact));
        assert.ok(Object.isFrozen(fact.identity));
        throw error;
      },
      failed(error) {
        reported = error;
        throw new Error('diagnostic unavailable');
      },
    },
  });
  assert.equal(await call.run(), 'answer');
  assert.equal(call.context.status, 'succeeded');
  assert.equal(call.failure, undefined);
  assert.equal(notifications, 1);
  assert.equal(reported, error);
});

test('unexpected asynchronous receive/report results are isolated without unhandled rejections', async () => {
  let notifications = 0;
  const channel = new ProgressChannel({
    async receive() {
      notifications++;
      throw new Error('late receive failure');
    },
    async failed() {
      throw new Error('late report failure');
    },
  });
  channel.publish(Object.freeze({ done: true }));
  channel.publish(Object.freeze({ done: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications, 1);
  assert.match(channel.failure.error.message, /synchronously/);
});

test('a throwing failure reporter getter and thrown undefined cannot escape or reactivate a channel', () => {
  let notifications = 0;
  const channel = new ProgressChannel({
    receive() {
      notifications++;
      throw undefined;
    },
    get failed() {
      throw new Error('failed getter');
    },
  });
  channel.publish({});
  channel.publish({});
  assert.deepEqual(channel.failure, { error: undefined });
  assert.equal(notifications, 1);
});

test('strict setup remains part of running, before started progress', async () => {
  const facts = [];
  const failure = new Error('setup failed');
  let executed = false;
  const call = invocation({
    started() {
      throw failure;
    },
    work: { execute: () => (executed = true) },
    progress: {
      receive(fact) {
        facts.push(fact);
      },
    },
  });
  await assert.rejects(call.run(), (error) => error === failure);
  assert.equal(executed, false);
  assert.deepEqual(
    facts.map(({ kind, status }) => [kind, status]),
    [['finished', 'failed']],
  );
});

test('progress precedes strict observation and reports the established call outcome', async () => {
  const facts = [];
  const failure = new Error('terminal observation failed');
  const call = invocation({
    progress: {
      receive(fact) {
        facts.push(fact);
      },
    },
    observation: {
      publish(fact) {
        if (fact.kind === 'finished') return failure;
      },
    },
  });
  await assert.rejects(call.run(), (error) => error === failure);
  assert.equal(call.context.status, 'succeeded');
  assert.deepEqual(
    facts.map(({ kind, status }) => [kind, status]),
    [
      ['started', undefined],
      ['finished', 'succeeded'],
    ],
  );
});

test('transcript commit progress survives strict capture failure and never contains message bodies', () => {
  const facts = [];
  const transcript = new Transcript([], {
    changes: {
      capture() {
        throw new Error('capture failed after commit');
      },
    },
  });
  const progress = new ProgressChannel({
    receive(fact) {
      facts.push(fact);
      assert.equal(transcript.length, 2);
      assert.equal(transcript.revision, 1);
    },
  });
  assert.throws(() => transcript.appendFrom([message('one'), message('two')], { progress }), /capture/i);
  assert.deepEqual(facts, [{ transcriptId: transcript.id, start: 0, end: 2, revision: 1 }]);
  assert.ok(Object.isFrozen(facts[0]));
  assert.equal(transcript.length, 2);
});

test('transcript progress cannot reenter mutation and does not undo or duplicate the append', () => {
  const transcript = new Transcript();
  const progress = new ProgressChannel({
    receive() {
      transcript.append(message('reentrant'));
    },
  });
  transcript.appendFrom([message('committed')], { progress });
  assert.equal(transcript.length, 1);
  assert.equal(transcript.get(0).content, 'committed');
  assert.match(progress.failure.error.message, /reenter/);
  transcript.appendFrom([message('next')], { progress });
  assert.equal(transcript.length, 2);
});

test('append resource bindings associate separate progress receivers with one entity', () => {
  const transcript = new Transcript();
  const input = [];
  const answer = [];
  const binding = bindResources({ messages: TranscriptResource.append.request() }, [TranscriptResource.append.provide((source) => source)]);
  const first = binding({
    transcript,
    progress: {
      receive(fact) {
        input.push(fact);
      },
    },
  });
  const second = binding({
    transcript,
    progress: {
      receive(fact) {
        answer.push(fact);
      },
    },
  });
  first.values.messages.append([message('input')]);
  second.values.messages.append([{ role: 'assistant', content: 'answer' }]);
  assert.deepEqual(input, [{ transcriptId: transcript.id, start: 0, end: 1, revision: 1 }]);
  assert.deepEqual(answer, [{ transcriptId: transcript.id, start: 1, end: 2, revision: 2 }]);
  assert.deepEqual(Object.keys(first.values.messages), ['append']);
  binding(transcript).values.messages.append([message('bare supply remains valid')]);
  assert.equal(transcript.length, 3);
});

test('append commit reaches its local receiver before resource returned observation can fail', () => {
  const transcript = new Transcript();
  const facts = [];
  const failure = new Error('returned observation failed');
  const binding = bindResources({ messages: TranscriptResource.append.request() }, [
    TranscriptResource.append.provide(() => ({
      transcript,
      progress: {
        receive(fact) {
          facts.push(fact);
        },
      },
    })),
  ])(null);
  binding.attach({
    contextId: 'owner',
    validate() {},
    observation: {
      publish(fact) {
        if (fact.phase === 'returned') return failure;
      },
    },
  });
  binding.start();
  assert.throws(
    () => binding.values.messages.append([message('committed')]),
    (error) => error === failure,
  );
  assert.deepEqual(facts, [{ transcriptId: transcript.id, start: 0, end: 1, revision: 1 }]);
  assert.equal(transcript.length, 1);
});

test('assembly selects execution progress by declaration and each run receives a separate identity', async () => {
  class Echo extends ExecutionDefinition {
    run = { requires: {}, execute: (context) => context.currentInput };
  }
  const execution = new Echo();
  const facts = [];
  const selected = [];
  const runtime = assembleRuntime(runtimeDefinition(execution), {
    providers: [],
    source: {
      entry: () => null,
      capture: () => null,
      progress(definition) {
        selected.push(definition);
        return {
          receive(fact) {
            facts.push(fact);
          },
        };
      },
    },
  });
  assert.equal(await runtime.run('first', {}), 'first');
  assert.equal(await runtime.run('second', {}), 'second');
  assert.deepEqual(selected, [execution, execution]);
  assert.deepEqual(
    facts.map(({ kind, identity }) => [kind, identity.level]),
    [
      ['started', 'execution'],
      ['finished', 'execution'],
      ['started', 'execution'],
      ['finished', 'execution'],
    ],
  );
  assert.notEqual(facts[0].identity.contextId, facts[2].identity.contextId);
  assert.ok(facts.every((fact) => typeof fact.identity.parentContextId === 'string'));
});
