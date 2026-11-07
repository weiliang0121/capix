import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceAccessClosed, ResourceOffer, ResourceSupply } from '@capix/resources';
import { CallableContext, Invocation, InvocationContext, InvocationResources, invocationResourceFailures } from '@capix/invocation';

// This fixture deliberately supplies a business entry directly: no structure,
// binding installation, Runner, recording preset or service environment is needed.
test('invocation boundary owns one execution and preserves its final value', async () => {
  const input = { word: 'hello' };
  const output = { translated: '你好' };
  let executions = 0;
  const call = new Invocation({
    context: new InvocationContext(input),
    signal: new AbortController().signal,
    work: {
      execute(context) {
        executions++;
        assert.deepEqual(context.currentInput, input);
        assert.notEqual(context.currentInput, input);
        assert.equal(Object.isFrozen(context.currentInput), true);
        return output;
      },
      output: { result: (value) => value },
    },
  });

  const result = await call.run();
  assert.deepEqual(result, output);
  assert.notEqual(result, output);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(call.context.state.output, result);
  assert.equal(call.context.progress.result.output, result);
  await assert.rejects(call.run(), /already started/);
  assert.equal(executions, 1);
  assert.equal(call.context.state.output, result);
});

test('invocation boundary handles a child business failure without making technical faults receivable', async () => {
  const unavailable = new Error('dictionary unavailable');
  const fallback = { translated: 'hello' };
  let failedChild;
  let received = 0;
  const parent = new Invocation({
    context: new InvocationContext('hello'),
    signal: new AbortController().signal,
    work: {
      async execute(context, owner) {
        failedChild = new Invocation({
          context: new InvocationContext(context.input),
          signal: new AbortController().signal,
          parent: { invocation: owner, receiveFailure: true },
          work: {
            execute: () => {
              throw unavailable;
            },
          },
        });
        await assert.rejects(failedChild.run(), (error) => error === unavailable);
        return owner.children.get(failedChild).handle((error) => {
          received++;
          assert.equal(error, unavailable);
          assert.deepEqual(owner.children.reception, { parentContextId: owner.context.id, childContextId: failedChild.context.id });
          return fallback;
        });
      },
    },
  });

  const result = await parent.run();
  assert.deepEqual(result, fallback);
  assert.notEqual(result, fallback);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(received, 1);
  assert.equal(failedChild.context.status, 'failed');
  assert.equal(parent.children.get(failedChild).returned.error, unavailable);
  assert.equal(parent.children.get(failedChild).reception.status, 'handled');
  assert.equal(parent.children.get(failedChild).reception.output, result);

  let invalidChild;
  let invalidDelivery;
  const invalidParent = new Invocation({
    context: new InvocationContext('hello'),
    signal: new AbortController().signal,
    work: {
      async execute(context, owner) {
        invalidChild = new Invocation({
          context: new InvocationContext(context.input),
          signal: new AbortController().signal,
          parent: { invocation: owner, receiveFailure: true },
          work: {
            execute: () => fallback,
            // A validator may check, but must not replace, the delivered value.
            output: { result: () => ({ ...fallback }) },
          },
        });
        await assert.rejects(invalidChild.run(), (error) => {
          invalidDelivery = error;
          return error.code === 'OUTPUT_CONTRACT';
        });
        await assert.rejects(
          owner.children.get(invalidChild).handle(() => assert.fail('technical faults cannot enter a business receiver')),
          (error) => error === invalidDelivery,
        );
        // Catching the rejected handling attempt cannot clear the parent's fault.
        return fallback;
      },
    },
  });

  await assert.rejects(invalidParent.run(), (error) => error === invalidDelivery);
  assert.equal(invalidParent.context.status, 'failed');
  assert.equal(invalidParent.children.get(invalidChild).returned.failure.receptionAllowed, false);
  assert.equal(invalidParent.children.get(invalidChild).reception.status, 'pending');
});

test('invocation boundary closes its resource window after success or failure', async () => {
  let reads = 0;
  const offer = new ResourceOffer({
    methods: {
      read(origin, word) {
        reads++;
        return origin.get(word);
      },
    },
  });
  const deps = { dictionary: offer.request() };
  const origin = new Map([['hello', '你好']]);
  const supply = ResourceSupply.capture([offer.provide(() => origin)], undefined);

  for (const outcome of ['succeeded', 'failed']) {
    const resources = new InvocationResources(deps, supply.entries);
    const context = new CallableContext('hello', 'node', {}, resources);
    const failure = new Error('processing failed after resource use');
    let retained;
    const call = new Invocation({
      context,
      signal: context.signal,
      work: {
        async execute(current) {
          retained = current.resources.values.dictionary;
          assert.equal(await retained.read(current.input), '你好');
          if (outcome === 'failed') throw failure;
          return '你好';
        },
      },
    });
    // The resource package sees a fixed owner contract, not Invocation or Scene.
    resources.attach({
      contextId: context.id,
      signal: context.signal,
      failures: invocationResourceFailures,
      validate: () => call.requireActive(),
      error: (error, allowException) => call.reject(error, allowException),
    });

    if (outcome === 'succeeded') assert.equal(await call.run(), '你好');
    else await assert.rejects(call.run(), (error) => error === failure);
    assert.equal(context.status, outcome);
    const readsBeforeLateUse = reads;
    await assert.rejects(retained.read('hello'), ResourceAccessClosed);
    assert.equal(reads, readsBeforeLateUse);
    assert.throws(() => resources.activate('run', deps), ResourceAccessClosed);
  }
  assert.equal(reads, 2);
});
