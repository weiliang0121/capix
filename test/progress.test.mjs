import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, InvocationCancelled, RuntimeError, ProgressChannel, Transcript, TranscriptResource, bindResources, Group, Node, bindCallSource } from '@capix/server-runtime';
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
        assert.deepEqual(Object.keys(fact), ['identity', 'eventSequence', 'occurredAt', 'kind']);
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
    facts.filter(({ kind }) => kind !== 'process').map(({ kind, status }) => [kind, status]),
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
    facts.filter(({ kind }) => kind !== 'process').map(({ kind, status }) => [kind, status]),
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
  assert.deepEqual(Object.keys(first.values.messages), ['applyFixed', 'append']);
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

test('assembly selects local execution progress by declaration and each run receives a separate identity', async () => {
  class Echo extends Group {
    run = { requires: {}, execute: (work) => work.input };
  }
  const execution = new Echo();
  const facts = [];
  const selected = [];
  const runtime = installCallable(runtimeDefinition(execution), {
    providers: [],
    source: {
      entry: () => null,
      capture: () => null,
    },
    bindings: [
      bindCallSource(execution, {
        progress() {
          selected.push(execution);
          return {
            receive(fact) {
              facts.push(fact);
            },
          };
        },
      }),
    ],
  });
  assert.equal(await runtime.run('first', {}), 'first');
  assert.equal(await runtime.run('second', {}), 'second');
  assert.deepEqual(selected, [execution, execution]);
  assert.deepEqual(
    facts.filter(({ kind }) => kind !== 'process').map(({ kind, identity }) => [kind, identity.kind]),
    [
      ['started', 'group'],
      ['finished', 'group'],
      ['started', 'group'],
      ['finished', 'group'],
    ],
  );
  assert.notEqual(facts[0].identity.contextId, facts.at(-1).identity.contextId);
  assert.ok(facts.every((fact) => typeof fact.identity.parentContextId === 'string'));
});

function delegated(child) {
  return {
    requires: {},
    uses: [child],
    async execute(work) {
      const call = work.children.create(child, work.input, { key: 'child' });
      const result = await call.run();
      return call.accept(() => result);
    },
  };
}

function hierarchy() {
  const attempt = new (class extends Node {
    name = 'echo';
    label = '测试能力';
    source = 'private-source';
    callee = 'private-provider';
    run = { requires: {}, execute: (work) => work.input };
  })();
  const operation = new (class extends Group {
    name = 'compose';
    label = '组合工作';
    source = 'private-operation-source';
    members = [attempt];
    run = delegated(attempt);
  })();
  const execution = new (class extends Group {
    members = [operation];
    run = delegated(operation);
  })();
  return runtimeDefinition(execution);
}

test('one per-run progress receiver sees REOA and parent acceptance without recording or IO', async () => {
  const runs = [];
  const runtime = installCallable(hierarchy(), {
    providers: [],
    source: {
      entry: () => null,
      capture: () => null,
      progress(input, options) {
        assert.equal(input, 'private-input');
        assert.equal(options.marker, 'per-call');
        const facts = [];
        runs.push(facts);
        return {
          receive: (fact) => {
            facts.push(fact);
          },
        };
      },
    },
  });
  assert.equal(await runtime.run('private-input', { marker: 'per-call' }), 'private-input');
  assert.equal(await runtime.run('private-input', { marker: 'per-call' }), 'private-input');
  assert.equal(runs.length, 2);
  for (const facts of runs) {
    assert.deepEqual(
      facts.filter((fact) => fact.kind === 'started').map((fact) => fact.identity.kind),
      ['scene', 'group', 'group', 'node'],
    );
    assert.deepEqual(
      facts.filter((fact) => fact.kind === 'finished').map((fact) => fact.identity.kind),
      ['node', 'group', 'group', 'scene'],
    );
    assert.equal(facts.filter((fact) => fact.kind === 'relation' && fact.phase === 'accepted').length, 3);
    for (const relation of facts.filter((fact) => fact.kind === 'relation' && fact.phase === 'returned')) {
      assert.equal(relation.status, 'succeeded');
      const finished = facts.findIndex((fact) => fact.kind === 'finished' && fact.identity.contextId === relation.relation.childContextId);
      const receiving = facts.findIndex((fact) => fact.kind === 'relation' && fact.phase === 'receiving' && fact.relation.childContextId === relation.relation.childContextId);
      assert.ok(finished < facts.indexOf(relation));
      assert.ok(facts.indexOf(relation) < receiving);
    }
    const sequences = new Map();
    for (const fact of facts) {
      assert.ok(Object.isFrozen(fact));
      assert.ok(Object.isFrozen(fact.identity));
      assert.ok(Number.isFinite(Date.parse(fact.occurredAt)));
      assert.ok(fact.eventSequence > (sequences.get(fact.identity.contextId) ?? 0));
      sequences.set(fact.identity.contextId, fact.eventSequence);
    }
    const visible = JSON.stringify(facts);
    assert.doesNotMatch(visible, /private-/);
    assert.match(visible, /测试能力/);
    assert.match(visible, /组合工作/);
    assert.equal(sequences.size, 4);
  }
  assert.notEqual(runs[0][0].identity.contextId, runs[1][0].identity.contextId);
});

test('local progress failure disables only its receiver while ancestor keeps the entire subtree', async () => {
  const facts = [];
  let localNotifications = 0;
  let localFailures = 0;
  const definition = hierarchy();
  const runtime = installCallable(definition, {
    providers: [],
    source: {
      capture: () => null,
      progress: () => ({
        receive: (fact) => {
          facts.push(fact);
        },
      }),
    },
    bindings: [
      bindCallSource(definition.members[0], {
        progress: () => ({
          receive() {
            localNotifications++;
            throw new Error('local projection unavailable');
          },
          failed() {
            localFailures++;
          },
        }),
      }),
    ],
  });
  assert.equal(await runtime.run('answer', {}), 'answer');
  assert.equal(localNotifications, 1);
  assert.equal(localFailures, 1);
  assert.equal(facts.filter((fact) => fact.kind === 'finished').length, 4);
  const factsById = new Set(facts.map((fact) => `${fact.identity.contextId}:${fact.eventSequence}`));
  assert.equal(factsById.size, facts.length);
});

test('process progress preserves distinct local rounds without exposing continuation content', async () => {
  const facts = [];
  const call = invocation({
    work: {
      maxRounds: 2,
      execute: (context) => context.currentInput,
      accept: (context, output) => (context.progress.round === 1 ? context.continueWith('private-followup', 'private-reason') : output),
    },
    progress: {
      receive: (fact) => {
        facts.push(fact);
      },
    },
  });
  assert.equal(await call.run(), 'private-followup');
  assert.deepEqual(
    facts.filter((fact) => fact.kind === 'process').map((fact) => [fact.round, fact.stage, fact.action]),
    [
      [1, 'execute', 'start'],
      [1, 'execute', 'return'],
      [1, 'receive', 'continue'],
      [2, 'execute', 'start'],
      [2, 'execute', 'return'],
      [2, 'receive', 'return'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(facts), /private-/);
});

test('finished progress calls only same-control cancellation cancelled, retaining owned errors', async () => {
  for (const mode of ['cancelled', 'other-signal', 'same-code', 'work-error']) {
    const controller = new AbortController();
    const other = new AbortController();
    const facts = [];
    const call = invocation({
      signal: controller.signal,
      work: {
        maxRounds: 1,
        execute() {
          controller.abort();
          if (mode === 'cancelled') throw new InvocationCancelled(controller.signal);
          if (mode === 'other-signal') {
            other.abort();
            throw new InvocationCancelled(other.signal);
          }
          if (mode === 'same-code') throw new RuntimeError('INVOCATION_CANCELLED', 'private-error');
          throw new Error('private-error');
        },
      },
      progress: {
        receive: (fact) => {
          facts.push(fact);
        },
      },
    });
    await assert.rejects(call.run());
    assert.equal(facts.at(-1).kind, 'finished');
    assert.equal(facts.at(-1).status, mode === 'cancelled' ? 'cancelled' : 'failed');
    assert.doesNotMatch(JSON.stringify(facts), /private-/);
  }
});

test('passive descriptions never execute getters or leak source and callee', async () => {
  const facts = [];
  const description = {
    get name() {
      assert.fail('metadata accessor must remain unevaluated');
    },
    label: 'safe label',
    source: 'private-source',
    callee: 'private-provider',
  };
  const call = invocation({
    description,
    progress: {
      receive: (fact) => {
        facts.push(fact);
      },
    },
  });
  assert.equal(await call.run(), 'answer');
  assert.deepEqual(facts[0].description, { label: 'safe label' });
  assert.ok(Object.isFrozen(facts[0].description));
  assert.doesNotMatch(JSON.stringify(facts), /private-/);
});

test('without a receiver the passive outlet does not inspect descriptions', async () => {
  let inspected = 0;
  const description = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        inspected++;
        throw new Error('must not inspect');
      },
    },
  );
  assert.equal(await invocation({ description }).run(), 'answer');
  assert.equal(inspected, 0);
});

test('child cancellation is distinguished in parent return progress and never accepted', async () => {
  const controller = new AbortController();
  const facts = [];
  const definition = hierarchy();
  const attempt = definition.members[0].members[0].members[0];
  attempt.run = {
    requires: {},
    execute() {
      controller.abort();
      throw new InvocationCancelled(controller.signal);
    },
  };
  const runtime = installCallable(definition, {
    providers: [],
    source: {
      entry: () => null,
      capture: () => null,
      progress: () => ({
        receive: (fact) => {
          facts.push(fact);
        },
      }),
    },
  });
  await assert.rejects(runtime.run('input', { signal: controller.signal }), (error) => error instanceof InvocationCancelled);
  assert.deepEqual(
    facts.filter((fact) => fact.kind === 'finished').map((fact) => fact.status),
    ['cancelled', 'cancelled', 'cancelled', 'cancelled'],
  );
  assert.deepEqual(
    facts.filter((fact) => fact.kind === 'relation' && fact.phase === 'returned').map((fact) => fact.status),
    ['cancelled', 'cancelled', 'cancelled'],
  );
  assert.equal(facts.filter((fact) => fact.kind === 'relation' && fact.phase === 'accepted').length, 0);
  assert.equal(runtime.running, false);
});
