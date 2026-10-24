import { installCallable } from '../fixtures/driver.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Invocation, InvocationContext, InvocationCancelled, isInvocationCancelled, RuntimeError, Scene, Group, ExceptionContract, ResourceOffer, bindResources } from '@capix/server-runtime';
import { observeCall } from '../fixtures/observation.mjs';

function call(controller, execute, extra = {}) {
  const { work, ...options } = extra;
  return new Invocation({ context: new InvocationContext(null), signal: controller.signal, work: { maxRounds: 1, execute, ...work }, ...options });
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

test('abort before normal acceptance stops acceptance without erasing the returned output', async () => {
  const controller = new AbortController();
  let accepted = 0;
  const invocation = call(
    controller,
    () => {
      controller.abort();
      return 'returned';
    },
    { work: { accept: () => accepted++ } },
  );
  await assert.rejects(invocation.run(), (error) => isInvocationCancelled(error, controller.signal));
  assert.equal(accepted, 0);
  assert.equal(invocation.context.progress.result.output, 'returned');
  assert.equal(invocation.context.state.error, invocation.failure.error);
});

test('cancellation does not retroactively change a completed acceptance', async () => {
  const controller = new AbortController();
  const invocation = call(controller, () => 'result', {
    work: {
      accept: (_context, output) => {
        controller.abort();
        return output;
      },
    },
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

test('cancellation from a process observer stops execution or handling before business work', async () => {
  for (const stage of ['execute', 'handling']) {
    const controller = new AbortController();
    const rejected = new ExceptionContract('TEST_REJECTED');
    const invocation = call(
      controller,
      () => {
        if (stage === 'execute') assert.fail('execution must not start');
        throw rejected.create('test', {});
      },
      {
        work: { raises: [rejected], exceptions: { accepts: [rejected], handle: () => assert.fail('handling must not start') } },
        observation: observeCall((fact) => {
          if (fact.kind === 'process' && fact.process.stage === stage && fact.process.type === 'start') controller.abort();
        }),
      },
    );
    await assert.rejects(invocation.run(), (error) => isInvocationCancelled(error, controller.signal));
  }
});

test('cancellation from resource start observation prevents synchronous and asynchronous effects', async () => {
  for (const asynchronous of [false, true]) {
    const controller = new AbortController();
    const effects = [];
    const offer = new ResourceOffer('test.effect', (_source, activity) => ({
      run: () => (asynchronous ? activity.runAsync('effect', {}, async () => effects.push('effect')) : activity.runSync('effect', {}, () => effects.push('effect'))),
    }));
    const resources = bindResources({ effect: offer.request() }, [offer.provide(() => null)])(null);
    resources.attach({
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

class Main extends Scene {
  constructor(execute, { children = [], deps = {} } = {}) {
    super();
    this.add(...children);
    this.run = { deps, uses: children, execute };
  }
}

function runtime(definition, providers = []) {
  return installCallable(definition, { providers, source: { runtime: () => null, capture: () => undefined } });
}

test('cancellation blocks new children before entry and releases Runtime occupancy', async () => {
  const controller = new AbortController();
  const execution = new (class extends Group {
    run = { deps: {}, execute: () => assert.fail('child must not run') };
    entry = { deps: {}, accept: () => assert.fail('entry must not run') };
  })();
  let parent;
  const bound = runtime(
    new Main(
      (work) => {
        parent = work;
        controller.abort();
        try {
          work.children.create(execution, null);
        } catch {}
        return 'caught but not recovered';
      },
      { children: [execution] },
    ),
  );
  await assert.rejects(bound.run(null, { signal: controller.signal }), (error) => isInvocationCancelled(error, controller.signal));
  assert.equal(parent.children.facts.values().length, 0);
  assert.equal(bound.running, false);
});

test('a returned child is not accepted after parent cancellation', async () => {
  const controller = new AbortController();
  const execution = new (class extends Group {
    run = { deps: {}, execute: () => 'child result' };
  })();
  let relation;
  let acceptances = 0;
  const bound = runtime(
    new Main(
      async (work) => {
        const child = work.children.create(execution, null);
        await child.run();
        relation = work.children.facts.get(child.ref);
        controller.abort();
        return child.accept(() => acceptances++);
      },
      { children: [execution] },
    ),
  );
  await assert.rejects(bound.run(null, { signal: controller.signal }), (error) => isInvocationCancelled(error, controller.signal));
  assert.equal(acceptances, 0);
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'pending');
  assert.equal(bound.running, false);
});

test('cached resource endpoints stop later writes but preserve already established effects', async () => {
  const controller = new AbortController();
  const writes = [];
  const offer = new ResourceOffer('test.write', (_source, activity) => ({ append: (value) => activity.runSync('append', {}, () => writes.push(value)) }));
  const bound = runtime(
    new Main(
      (work) => {
        const endpoint = work.resources.writer;
        endpoint.append('before');
        controller.abort();
        try {
          endpoint.append('after');
        } catch {}
        return 'ignored';
      },
      { deps: { writer: offer.request() } },
    ),
    [offer.provide(() => null)],
  );
  await assert.rejects(bound.run(null, { signal: controller.signal }), (error) => isInvocationCancelled(error, controller.signal));
  assert.deepEqual(writes, ['before']);
  assert.equal(bound.running, false);
});
