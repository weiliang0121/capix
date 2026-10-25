import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, Node, Resources, Runner, defineObservation } from '@capix/server-runtime';

const install = (scene, observations) => new Runner(scene, new Resources(), undefined, { observations }).build();
const consumer = (declarations, options = {}) => ({ declarations, bindInvocation: () => ({ observe() {} }), ...options });
function oneNode() {
  const node = new Node({ run: (work) => work.input });
  return { node, scene: new Scene({ run: (work) => work.children.invoke(node, work.input) }).add(node) };
}

for (const failure of ['isolate', 'propagate']) {
  test(`a resource-free declaration inherits its owner's ${failure} policy`, async () => {
    const { scene, node } = oneNode();
    const fault = new Error('host observation failure');
    const invalidated = [];
    const declaration = defineObservation({
      deps: {},
      observe(fact) {
        if (fact.kind === 'started') throw fault;
      },
    });
    const owner = consumer((scope) => (scope === node ? [declaration] : []), { failure, invalidate: (error) => invalidated.push(error) });
    const runner = install(scene, [owner]);
    if (failure === 'isolate') assert.equal(await runner.run('input'), 'input');
    else await assert.rejects(runner.run('input'), /Observation failed/);
    assert.equal(invalidated.length, 1);
    assert.equal(invalidated[0].cause, fault);
  });
}

test('the same declaration selected by two installations has two isolated owners', async () => {
  const { scene, node } = oneNode();
  let starts = 0;
  const disabled = [];
  const declaration = defineObservation({
    deps: {},
    observe(fact) {
      if (fact.kind === 'started' && ++starts === 1) throw new Error('first owner only');
    },
  });
  const first = consumer((scope) => (scope === node ? [declaration] : []), { invalidate: () => disabled.push('first') });
  const second = consumer((scope) => (scope === node ? [declaration] : []), { invalidate: () => disabled.push('second') });
  const runner = install(scene, [first, second]);
  assert.equal(await runner.run('one'), 'one');
  assert.equal(starts, 2, 'the peer receives the same fact after the first owner fails');
  assert.deepEqual(disabled, ['first']);
  assert.equal(await runner.run('two'), 'two');
  assert.equal(starts, 4, 'a new root call creates fresh observer sessions');
});

for (const [ownerFailure, declarationFailure] of [
  ['propagate', 'isolate'],
  ['isolate', 'propagate'],
]) {
  test(`a declaration's explicit ${declarationFailure} overrides its owner's ${ownerFailure}`, async () => {
    const { scene, node } = oneNode();
    let invalidated = 0;
    const declaration = defineObservation(
      {
        deps: {},
        observe(fact) {
          if (fact.kind === 'started') throw new Error('explicit declaration failure');
        },
      },
      { failure: declarationFailure },
    );
    const owner = consumer((scope) => (scope === node ? [declaration] : []), { failure: ownerFailure, invalidate: () => invalidated++ });
    const runner = install(scene, [owner]);
    if (declarationFailure === 'isolate') assert.equal(await runner.run('input'), 'input');
    else await assert.rejects(runner.run('input'), /Observation failed/);
    assert.equal(invalidated, 1);
  });
}

test('disabling an owner stops its existing child and later descendants, while a peer stays active', async () => {
  let started;
  let release;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const leaf = new Node({ name: 'leaf', run: () => 'done' });
  const branch = new Group({
    name: 'branch',
    async run(work) {
      started();
      await gate;
      work.observation({ event: 'child-resumed' });
      return work.children.invoke(leaf, null);
    },
  });
  branch.add(leaf);
  const scene = new Scene({
    name: 'scene',
    async run(work) {
      const running = work.children.invoke(branch, null);
      await entered;
      work.observation({ event: 'disable-owner' });
      release();
      await running;
      return work.children.invoke(branch, null);
    },
  });
  scene.add(branch);
  const failingFacts = [];
  const healthyFacts = [];
  const failingBusiness = [];
  const disabled = [];
  const declaration = defineObservation({
    deps: {},
    observe: (fact) => {
      failingFacts.push([fact.description.name, fact.kind]);
    },
  });
  const healthy = defineObservation({
    deps: {},
    observe: (fact) => {
      healthyFacts.push([fact.description.name, fact.kind]);
    },
  });
  const owner = consumer(() => [declaration], {
    bindInvocation: () => ({
      observe() {},
      business(fact) {
        failingBusiness.push(fact.event.event);
        if (fact.event.event === 'disable-owner') throw new Error('close this owner');
      },
    }),
    invalidate: (error) => disabled.push(error),
  });
  assert.equal(await install(scene, [owner, consumer(() => [healthy])]).run(null), 'done');
  assert.equal(disabled.length, 1);
  assert.ok(failingFacts.some(([name, kind]) => name === 'branch' && kind === 'started'));
  assert.ok(!failingFacts.some(([name, kind]) => name === 'branch' && kind === 'finished'), 'an already bound child cannot outlive its owner session');
  assert.ok(!failingFacts.some(([name]) => name === 'leaf'), 'a descendant created after owner shutdown is never installed');
  assert.deepEqual(failingBusiness, ['disable-owner']);
  assert.equal(healthyFacts.filter(([name, kind]) => name === 'branch' && kind === 'finished').length, 2);
  assert.equal(healthyFacts.filter(([name, kind]) => name === 'leaf' && kind === 'finished').length, 2);
});
