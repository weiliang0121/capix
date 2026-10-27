import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Node, Resources, Runner } from '@capix/server-runtime';
import { InvocationCancelled, Invocation, InvocationContext } from '@capix/invocation';
import { Resource, ResourceOffer } from '@capix/resources';

const make = (execute, options = {}) => new Invocation({ context: new InvocationContext('input'), signal: new AbortController().signal, work: { execute }, ...options });
const runtime = (scene, options = {}) => new Runner(scene, new Resources(), undefined, options).build();
function observer(facts) {
  return { bindInvocation: () => ({ observe: (fact) => facts.push(fact) }) };
}

test('one invocation executes once and reports no independent receive or handling stage', async () => {
  const facts = [];
  const input = { value: 0 };
  const output = { value: 2 };
  let runs = 0;
  const scene = new Scene({
    run(work) {
      runs++;
      assert.equal(work.input, input);
      assert.equal('round' in work, false);
      assert.equal('initialInput' in work, false);
      assert.equal('continue' in work, false);
      assert.equal('continuation' in work, false);
      return output;
    },
  });
  assert.equal(await runtime(scene, { observations: [observer(facts)] }).run(input), output);
  assert.equal(runs, 1);
  assert.deepEqual(
    facts.filter((fact) => fact.kind === 'process').map((fact) => [fact.process.stage, fact.process.type]),
    [
      ['execute', 'start'],
      ['execute', 'return'],
    ],
  );
});

test('business retry uses repeated child operations, never a second execution of the parent', async () => {
  let attempts = 0;
  let parents = 0;
  let children;
  const candidate = new Node({
    run() {
      if (++attempts === 1) throw new Error('first candidate');
      return { valid: true };
    },
  });
  const scene = new Scene({
    async run(work) {
      parents++;
      const result = await work.children.invoke(candidate, null, { result: { failed: () => work.children.invoke(candidate, null) } });
      children = work.children.facts.values();
      return result;
    },
  }).add(candidate);
  assert.deepEqual(await runtime(scene).run(null), { valid: true });
  assert.equal(parents, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(
    children.map((child) => [child.returned.status, child.reception.status]),
    [
      ['failed', 'handled'],
      ['succeeded', 'accepted'],
    ],
  );
  assert.notEqual(children[0].ref, children[1].ref);
});

test('ordinary unhandled errors retain their identity without exception declarations', async () => {
  for (const error of [new Error('work'), new TypeError('domain'), undefined, null]) {
    const call = make(() => {
      throw error;
    });
    try {
      await call.run();
      assert.fail('must reject');
    } catch (actual) {
      assert.equal(actual, error);
    }
    assert.equal(call.context.state.error, error);
    assert.equal(call.context.status, 'failed');
  }
});

test('pre-cancellation does not enter the business function', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  const call = make(() => assert.fail('must not execute'), { signal: controller.signal });
  await assert.rejects(call.run(), (error) => error instanceof InvocationCancelled);
});

test('cancellation before the final result prevents successful delivery', async () => {
  const controller = new AbortController();
  const call = make(
    () => {
      controller.abort();
      return 'candidate';
    },
    { signal: controller.signal },
  );
  await assert.rejects(call.run(), (error) => error instanceof InvocationCancelled);
  assert.equal(call.context.status, 'failed');
});

test('success preserves references and output validation cannot replace the value', async () => {
  const value = { output: true };
  const good = make(() => value, {
    work: {
      execute: () => value,
      output: {
        result: (actual) => {
          assert.equal(actual, value);
          return actual;
        },
      },
    },
  });
  assert.equal(await good.run(), value);
  const bad = make(() => value, { work: { execute: () => value, output: { result: () => ({ output: true }) } } });
  await assert.rejects(bad.run(), (error) => error.code === 'OUTPUT_CONTRACT');
});

test('strict observation cannot be hidden by a business fallback or retry', async () => {
  const failure = new Error('fact store');
  let attempted = 0;
  let fallback = 0;
  const child = new Node({ run: () => ++attempted });
  const scene = new Scene({ run: (work) => work.children.invoke(child, null, { result: { failed: () => ++fallback } }) }).add(child);
  const installation = {
    failure: 'propagate',
    bindInvocation: ({ identity }) => ({
      observe(fact) {
        if (identity.kind === 'node' && fact.kind === 'process' && fact.process.type === 'return') throw failure;
      },
    }),
  };
  await assert.rejects(runtime(scene, { observations: [installation] }).run(null));
  assert.equal(attempted, 1);
  assert.equal(fallback, 0);
});

test('work and output failures both remain visible when their reporting fails', async () => {
  const cause = new Error('business');
  const reporting = new Error('reporting');
  const call = make(
    () => {
      throw cause;
    },
    {
      changes: {
        publish(fact) {
          if (fact.kind === 'process' && fact.action === 'throw') throw reporting;
        },
      },
    },
  );
  await assert.rejects(call.run(), (error) => error instanceof AggregateError && error.errors.includes(cause));
});

test('completed work resource windows cannot be reused by retained endpoints', async () => {
  const offer = new ResourceOffer({
    methods: {
      read(origin) {
        return origin.value;
      },
    },
  });
  let retained;
  const scene = new Scene({
    deps: { data: offer.request() },
    run(work) {
      retained = work.resources.data;
      return retained.read();
    },
  });
  const resources = new Resources().register(new Resource({ value: 7 }), offer);
  assert.equal(await new Runner(scene, resources).build().run(null), 7);
  await assert.rejects(retained.read(), /ended|closed|active/);
});

test('cyclic aggregate errors do not recurse during classification', async () => {
  const failure = new AggregateError([], 'cyclic');
  failure.errors.push(failure);
  await assert.rejects(
    make(() => {
      throw failure;
    }).run(),
    (error) => error === failure,
  );
});
