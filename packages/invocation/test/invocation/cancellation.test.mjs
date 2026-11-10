import { bindResources } from '../fixtures/resources.mjs';

import { invocationResourceFailures, Invocation, InvocationContext, InvocationCancelled, isInvocationCancelled } from '@weiliang0121/capix-invocation';

import test from 'node:test';

import assert from 'node:assert/strict';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { ResourceOffer } from '@weiliang0121/capix-resources';

import { observeCall } from '../fixtures/observation.mjs';

function call(controller, execute, extra = {}) {
  const { work, ...options } = extra;
  return new Invocation({ context: new InvocationContext(null), signal: controller.signal, work: { execute, ...work }, ...options });
}

test('cancellation identity belongs to the exact control signal, never a code or nested cause', () => {
  const controller = new AbortController();
  const unrelated = new AbortController();
  const reason = new Error('stop');
  assert.throws(() => new InvocationCancelled(controller.signal), /aborted signal/);
  controller.abort(reason);
  unrelated.abort(reason);
  const error = new InvocationCancelled(controller.signal);
  assert.equal(error.cause, reason);
  assert.equal(isInvocationCancelled(error, controller.signal), true);
  assert.equal(isInvocationCancelled(error, unrelated.signal), false);
  assert.equal(isInvocationCancelled(new RuntimeError('INVOCATION_CANCELLED', 'same code'), controller.signal), false);
  assert.equal(isInvocationCancelled(new AggregateError([error, new Error('observation')]), controller.signal), false);
  assert.equal(isInvocationCancelled(new Error('wrapper', { cause: error }), controller.signal), false);
});

test('work failure beats concurrent abort and keeps Context, Invocation and delivery consistent', async () => {
  for (const asynchronous of [false, true]) {
    const controller = new AbortController();
    const fault = new Error('work failed');
    const fail = () => {
      controller.abort();
      throw fault;
    };
    const invocation = call(controller, asynchronous ? async () => fail() : fail);
    await assert.rejects(invocation.run(), (error) => error === fault);
    assert.equal(invocation.context.state.error, fault);
    assert.equal(invocation.failure.error, fault);
    assert.equal(invocation.context.progress.result.error, fault);
    assert.equal(isInvocationCancelled(invocation.failure.error, controller.signal), false);
  }
});

test('an already owned failure cannot be replaced by a later cancelled result', async () => {
  const controller = new AbortController();
  const fault = new Error('owned failure');
  const invocation = call(controller, (_context, current) => {
    current.reject(fault);
    controller.abort();
    throw new InvocationCancelled(controller.signal);
  });
  await assert.rejects(invocation.run(), (error) => error === fault);
  assert.equal(invocation.context.state.error, fault);
  assert.equal(invocation.failure.error, fault);
});

test('abort after business return preserves the candidate and prevents final delivery', async () => {
  const controller = new AbortController();
  const invocation = call(controller, () => {
    controller.abort();
    return 'returned';
  });
  await assert.rejects(invocation.run(), (error) => isInvocationCancelled(error, controller.signal));
  assert.equal(invocation.context.progress.result.output, 'returned');
  assert.equal(invocation.context.state.error, invocation.failure.error);
});

test('cancellation after terminal completion cannot rewrite the successful outcome', async () => {
  const controller = new AbortController();
  const invocation = call(controller, () => 'result', {
    observation: observeCall((fact) => {
      if (fact.kind === 'finished') controller.abort();
    }),
  });
  assert.equal(await invocation.run(), 'result');
  assert.equal(invocation.context.status, 'succeeded');
});

test('strict failure while reporting cancellation remains a composite failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const observation = observeCall((fact) => {
    if (fact.kind === 'finished') throw new Error('cannot record the finish');
  });
  const invocation = call(controller, () => assert.fail('cancelled work must not run'), { observation });
  await assert.rejects(invocation.run(), (error) => error instanceof AggregateError && !isInvocationCancelled(error, controller.signal));
  assert.equal(isInvocationCancelled(invocation.context.state.error, controller.signal), true);
});

test('cancellation from the entry process observer prevents business work', async () => {
  const controller = new AbortController();
  const invocation = call(controller, () => assert.fail('must not execute'), {
    observation: observeCall((fact) => {
      if (fact.kind === 'process' && fact.process.type === 'start') controller.abort();
    }),
  });
  await assert.rejects(invocation.run(), (error) => isInvocationCancelled(error, controller.signal));
});

test('cancellation from resource start observation prevents synchronous and asynchronous effects', async () => {
  for (const asynchronous of [false, true]) {
    const controller = new AbortController();
    const effects = [];
    const offer = new ResourceOffer({
      name: 'test.effect',
      expose: (_source, activity) => ({
        run: () => (asynchronous ? activity.runAsync('effect', {}, async () => effects.push('effect')) : activity.runSync('effect', {}, () => effects.push('effect'))),
      }),
    });
    const resources = bindResources({ effect: offer.request() }, [offer.provide(() => null)])(null);
    resources.attach({
      failures: invocationResourceFailures,
      contextId: 'test',
      validate: () => {
        if (controller.signal.aborted) throw new InvocationCancelled(controller.signal);
      },
      observation: {
        publish: (fact) => {
          if (fact.phase === 'started') controller.abort();
        },
      },
    });
    resources.start();
    await assert.rejects(
      async () => resources.values.effect.run(),
      (error) => isInvocationCancelled(error, controller.signal),
    );
    assert.deepEqual(effects, []);
  }
});
