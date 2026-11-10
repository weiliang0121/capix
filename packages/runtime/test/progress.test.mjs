import { bindResources } from './fixtures/resources.mjs';

import { invocationResourceFailures, InvocationCancelled } from '@weiliang0121/capix-invocation';

import { installCallable } from './fixtures/driver.mjs';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Group, Node, bindCallSource } from '@weiliang0121/capix-runtime';

import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

import { runtimeDefinition } from './fixtures/declarations.mjs';

const message = (content) => ({ role: 'user', content });

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
    failures: invocationResourceFailures,
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
    deps = {};
    run = (work) => work.input;
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
  return async (work) => {
    const call = work.children.create(child, work.input, { key: 'child' });
    const result = await call.run();
    return call.accept(() => result);
  };
}

function hierarchy() {
  const attempt = new (class extends Node {
    name = 'echo';
    label = '测试能力';
    source = 'private-source';
    deps = {};
    run = (work) => work.input;
  })();
  const operation = new (class extends Group {
    name = 'compose';
    label = '组合工作';
    source = 'private-operation-source';
    constructor() {
      super();
      this.add(attempt);
    }
    run = delegated(attempt);
  })();
  const execution = new (class extends Group {
    constructor() {
      super();
      this.add(operation);
    }
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

test('child cancellation is distinguished in parent return progress and never accepted', async () => {
  const controller = new AbortController();
  const facts = [];
  const definition = hierarchy();
  const attempt = definition.members[0].members[0].members[0];
  attempt.deps = {};
  attempt.run = function () {
    controller.abort();
    throw new InvocationCancelled(controller.signal);
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
