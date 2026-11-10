import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Node, Scene, Runner, Resources, callableHooks } from '@weiliang0121/capix-runtime';

import { ExceptionContract } from '@weiliang0121/capix-invocation';

import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';

const runtime = (scene, options = {}, resources = new Resources()) => new Runner(scene, resources, undefined, options).build();

test('a local result receiver handles ordinary and typed domain errors without raises declarations', async () => {
  const contract = new ExceptionContract('DOMAIN_REJECTED');
  for (const error of [new Error('ordinary'), contract.create('domain', { detail: 7 })]) {
    let received;
    const child = new Node({
      run() {
        throw error;
      },
    });
    const scene = new Scene({
      run: (work) =>
        work.children.invoke(child, null, {
          result: {
            failed(value) {
              received = value;
              return 'fallback';
            },
          },
        }),
    }).add(child);
    assert.equal(await runtime(scene).run(null), 'fallback');
    assert.equal(received, error);
  }
});

test('success and failure receiver errors never recurse into the same failed callback', async () => {
  for (const sourceFails of [false, true]) {
    const receptionError = new Error('receiver');
    let failures = 0;
    const child = new Node({
      run() {
        if (sourceFails) throw new Error('source');
        return 1;
      },
    });
    const scene = new Scene({
      run: (work) =>
        work.children.invoke(child, null, {
          result: {
            succeeded() {
              throw receptionError;
            },
            failed() {
              failures++;
              throw receptionError;
            },
          },
        }),
    }).add(child);
    await assert.rejects(runtime(scene).run(null), (error) => error === receptionError);
    assert.equal(failures, Number(sourceFails));
  }
});

test('a precise checkpoint handle uses the same result receiver and preserves failed facts', async () => {
  const failure = new Error('candidate');
  const child = new Node({
    run() {
      throw failure;
    },
  });
  let fact;
  const scene = new Scene({
    async run(work) {
      const call = work.children.create(child, null);
      const value = await call.invoke({
        result: {
          failed: (error) => {
            assert.equal(error, failure);
            return 7;
          },
        },
      });
      fact = work.children.facts.get(call.ref);
      return value;
    },
  }).add(child);
  assert.equal(await runtime(scene).run(null), 7);
  assert.equal(fact.returned.status, 'failed');
  assert.deepEqual(fact.reception, { status: 'handled', value: 7 });
});

test('a result receiver can use another registered node as the replacement', async () => {
  const failing = new Node({
    run() {
      throw new Error('unavailable');
    },
  });
  const backup = new Node({ run: (work) => work.input * 2 });
  const scene = new Scene({ run: (work) => work.children.invoke(failing, null, { result: { failed: () => work.children.invoke(backup, 3) } }) }).add(failing, backup);
  assert.equal(await runtime(scene).run(null), 6);
});

test('raw child failures are not erased by catch and relabel', async () => {
  const failure = new Error('child');
  const child = new Node({
    run() {
      throw failure;
    },
  });
  const scene = new Scene({
    async run(work) {
      try {
        await work.children.create(child, null).run();
      } catch {}
      return 'not authorized';
    },
  }).add(child);
  await assert.rejects(runtime(scene).run(null), (error) => error === failure);
});

test('required resource observation failures cannot be consumed as source errors', async () => {
  let fallback = 0;
  const offer = new ResourceOffer({
    methods: {
      read(origin) {
        return origin;
      },
    },
  });
  const scene = new Scene({ deps: { read: offer.request() }, run: (work) => work.resources.read.read(null, { result: { failed: () => ++fallback } }) });
  const observation = {
    failure: 'propagate',
    bindInvocation: () => ({
      observe() {},
      resource() {
        throw new Error('durable fact');
      },
    }),
  };
  await assert.rejects(runtime(scene, { observations: [observation] }, new Resources().register(new Resource(1), offer)).run(null));
  assert.equal(fallback, 0);
});

test('a successful child context and rejected terminal delivery remain separate', async () => {
  let call;
  const failure = new Error('terminal observation');
  const child = new Node({ run: () => 1 });
  const scene = new Scene({ run: (work) => work.children.invoke(child, null, { result: { failed: () => assert.fail('cannot consume terminal observer failure') } }) }).add(child);
  const hooks = [
    callableHooks(child, {
      started: () => (_context, invocation) => {
        call = invocation;
      },
    }),
  ];
  const observation = {
    failure: 'propagate',
    bindInvocation: ({ identity }) => ({
      observe(fact) {
        if (identity.kind === 'node' && fact.kind === 'finished') throw failure;
      },
    }),
  };
  await assert.rejects(runtime(scene, { hooks, observations: [observation] }).run(null));
  assert.equal(call.context.status, 'succeeded');
  assert.equal(call.failure.receptionAllowed, false);
});

test('a protected child failure is owned before a registered receiver checks simultaneous cancellation', async () => {
  const controller = new AbortController(),
    fault = new Error('strict terminal observer');
  let fallbacks = 0;
  const child = new Node({ run: () => 'candidate' });
  const scene = new Scene({
    run: (work) =>
      work.children.invoke(child, null, {
        result: {
          failed: () => {
            fallbacks++;
            return 'masked';
          },
        },
      }),
  }).add(child);
  const observation = {
    failure: 'propagate',
    bindInvocation: ({ identity }) => ({
      observe(fact) {
        if (identity.kind === 'node' && fact.kind === 'finished') {
          controller.abort();
          throw fault;
        }
      },
    }),
  };
  await assert.rejects(runtime(scene, { observations: [observation] }).run(null, { signal: controller.signal }), (error) => error.code === 'OBSERVATION_FAILED' && error.cause === fault);
  assert.equal(fallbacks, 0);
});

for (const domain of [false, true]) {
  test(`a child ${domain ? 'domain' : 'ordinary'} failure racing cancellation retains the source cause without reception`, async () => {
    const controller = new AbortController();
    const failure = domain ? new ExceptionContract('RACING_CHILD').create('source failure', {}) : new Error('source failure');
    let fallbacks = 0;
    const child = new Node({
      run() {
        controller.abort();
        throw failure;
      },
    });
    const scene = new Scene({ run: (work) => work.children.invoke(child, null, { result: { failed: () => ++fallbacks } }) }).add(child);
    await assert.rejects(runtime(scene).run(null, { signal: controller.signal }), (error) => error === failure || error.cause === failure);
    assert.equal(fallbacks, 0);
  });
}
