import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Scene, Node, Resources, Runner } from '@weiliang0121/capix-runtime';

import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';

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
      assert.deepEqual(work.input, input);
      assert.notEqual(work.input, input);
      assert.equal(Object.isFrozen(work.input), true);
      assert.equal('round' in work, false);
      assert.equal('initialInput' in work, false);
      assert.equal('continue' in work, false);
      assert.equal('continuation' in work, false);
      return output;
    },
  });
  const result = await runtime(scene, { observations: [observer(facts)] }).run(input);
  assert.deepEqual(result, output);
  assert.notEqual(result, output);
  assert.equal(Object.isFrozen(result), true);
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
