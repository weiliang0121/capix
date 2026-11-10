import { Invocation, InvocationContext, InvocationCancelled } from '@weiliang0121/capix-invocation';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

const invocation = (options = {}) => new Invocation({ context: new InvocationContext('input'), work: { execute: () => 'answer' }, signal: new AbortController().signal, ...options });

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

test('process progress reports the single business run without exposing its input or result', async () => {
  const facts = [];
  const call = invocation({
    work: { execute: () => 'private-result' },
    progress: {
      receive: (fact) => {
        facts.push(fact);
      },
    },
  });
  assert.equal(await call.run(), 'private-result');
  assert.deepEqual(
    facts.filter((fact) => fact.kind === 'process').map((fact) => [fact.round, fact.stage, fact.action]),
    [
      [1, 'execute', 'start'],
      [1, 'execute', 'return'],
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
