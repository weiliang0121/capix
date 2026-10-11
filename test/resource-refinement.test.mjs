import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceOffer, bindResources, bindChildResources, assembleRuntime, Recorder, RecordBook, bindRecording } from '@capix/server-runtime';
import { runtimeDefinition, recordDefinitions } from './fixtures/declarations.mjs';

function fixture({ recorded = false, mapOperation = (input) => input.allowed, mapAttempt = (input) => input.leaf } = {}) {
  const counters = { capture: 0, refine: 0, describe: 0, dormant: 0 };
  const endpoints = [];
  const offer = new ResourceOffer('test.bounded', (source, activity) => Object.freeze({ read: () => activity.runSync('read', {}, () => source.allowed) }), 'access', {
    capture(source) {
      counters.capture++;
      return Object.freeze({ allowed: Object.freeze([...source.allowed]) });
    },
    refine(source, allowed) {
      counters.refine++;
      if (allowed.some((value) => !source.allowed.includes(value))) throw new Error('Cannot widen access');
      return Object.freeze({ allowed: Object.freeze([...allowed]) });
    },
    describe(source) {
      counters.describe++;
      return { allowed: source.allowed };
    },
  });
  const dormant = new ResourceOffer('test.dormant', () => assert.fail('unrequested endpoint'), 'access');
  const requires = { bounded: offer.request(), dormant: dormant.request() };
  const attempt = {
    level: 'attempt',
    name: 'leaf',
    label: 'Leaf',
    source: 'test',
    callee: 'test',
    maxRounds: 1,
    raises: [],
    run: {
      requires: { bounded: offer.request() },
      execute(context) {
        const endpoint = context.resources.values.bounded;
        endpoints.push(endpoint);
        return endpoint.read();
      },
    },
  };
  const operation = {
    level: 'operation',
    name: 'work',
    label: 'Work',
    source: 'test',
    maxRounds: 1,
    raises: [],
    children: [attempt],
    run: {
      requires,
      async execute(context, invocation, children) {
        const endpoint = context.resources.values.bounded;
        const own = endpoint.read();
        endpoints.push(endpoint);
        const output = await children.get(attempt).call(invocation, context.currentInput);
        return { own, output, after: endpoint.read() };
      },
    },
  };
  const execution = {
    level: 'execution',
    maxRounds: 1,
    raises: [],
    children: [operation],
    run: {
      requires,
      async execute(context, invocation, children) {
        const before = context.resources.values.bounded.read();
        const results = [];
        for (const input of context.currentInput) results.push(await children.get(operation).call(invocation, input));
        return { before, results, after: context.resources.values.bounded.read() };
      },
    },
  };
  const definition = runtimeDefinition(execution);
  const recorder = new Recorder(new RecordBook());
  if (recorded) recordDefinitions(definition);
  const options = {
    providers: [
      offer.provide((source) => source),
      dormant.provide(() => {
        counters.dormant++;
        return null;
      }),
    ],
    source: { entry: () => null, capture: () => ({ allowed: ['a', 'b', 'c'] }) },
    childResources: [bindChildResources(operation, [offer.refine(mapOperation)]), bindChildResources(attempt, [offer.refine(mapAttempt)])],
    observations: recorded ? [bindRecording(recorder)] : undefined,
  };
  return { runtime: assembleRuntime(definition, options), definition, options, offer, operation, attempt, counters, endpoints, recorder };
}

test('child input refines O and A supplies without recapturing or mutating ancestors and siblings', async () => {
  const { runtime, counters, endpoints } = fixture();
  const result = await runtime.run(
    [
      { allowed: ['a', 'b'], leaf: ['a'] },
      { allowed: ['c'], leaf: ['c'] },
    ],
    {},
  );
  assert.deepEqual(result, {
    before: ['a', 'b', 'c'],
    results: [
      { own: ['a', 'b'], output: ['a'], after: ['a', 'b'] },
      { own: ['c'], output: ['c'], after: ['c'] },
    ],
    after: ['a', 'b', 'c'],
  });
  assert.deepEqual(counters, { capture: 1, refine: 4, describe: 0, dormant: 0 });
  for (const endpoint of endpoints) assert.throws(() => endpoint.read(), /ended|running/);
  await runtime.run([{ allowed: ['b'], leaf: ['b'] }], {});
  assert.equal(counters.capture, 2);
});

test('refinement is fixed during call creation, before input can change or work starts', () => {
  const { offer } = fixture();
  const requires = { bounded: offer.request() };
  const parent = bindResources(requires, [offer.provide((source) => source)])({ allowed: ['a', 'b'] });
  const input = { allowed: ['a'] };
  const child = parent.select(requires, requires, { input, refinements: [offer.refine((value) => value.allowed)] });
  input.allowed.push('b');
  assert.deepEqual(child.values.bounded.read(), ['a']);
  assert.deepEqual(parent.values.bounded.read(), ['a', 'b']);
});

test('resource rejects widening before creating the child and the runtime releases occupancy', async () => {
  const { runtime, counters, recorder } = fixture({ recorded: true });
  await assert.rejects(runtime.run([{ allowed: ['a'], leaf: ['b'] }], {}), /Cannot widen access/);
  assert.equal(runtime.running, false);
  assert.equal(counters.refine, 2);
  assert.equal([...recorder.book.values()].filter((record) => record.kind === 'attempt').length, 0);
  assert.deepEqual((await runtime.run([{ allowed: ['b'], leaf: ['b'] }], {})).results[0].output, ['b']);
});

test('refined resources retain call-local bound and available observations with independent supply identities', async () => {
  const { runtime, recorder, counters } = fixture({ recorded: true });
  await runtime.run([{ allowed: ['a', 'b'], leaf: ['a'] }], {});
  const records = [...recorder.book.values()].filter((record) => record.kind === 'resource' && record.access === 'test.bounded');
  const available = records.filter((record) => record.phase === 'available');
  assert.equal(available.length, 3);
  assert.deepEqual(
    available.map((record) => record.value.allowed),
    [['a', 'b', 'c'], ['a', 'b'], ['a']],
  );
  assert.equal(new Set(available.map((record) => record.supplyId)).size, 3);
  assert.equal(new Set(available.map((record) => record.parentId)).size, 3);
  for (const record of available) assert.ok(records.some((candidate) => candidate.phase === 'bound' && candidate.supplyId === record.supplyId && candidate.parentId === record.parentId));
  assert.equal(counters.describe, 3);
});

test('assembly rejects unknown targets, duplicate bindings, and refinements outside declared requests', () => {
  const { definition, options, operation, offer, counters } = fixture();
  const unknown = { ...operation };
  assert.throws(() => assembleRuntime(definition, { ...options, childResources: [bindChildResources(unknown, [offer.refine((input) => input.allowed)])] }), /declared operation or attempt/);
  assert.throws(() => assembleRuntime(definition, { ...options, childResources: [options.childResources[0], options.childResources[0]] }), /Duplicate child resource binding/);
  assert.throws(() => bindChildResources(operation, [offer.refine(() => []), offer.refine(() => [])]), /Duplicate resource refinement/);
  const other = new ResourceOffer('other', (source) => source, 'access', { refine: (source) => source });
  assert.throws(() => assembleRuntime(definition, { ...options, childResources: [bindChildResources(operation, [other.refine(() => [])])] }), /Refined resource is not requested/);
  assert.deepEqual(counters, { capture: 0, refine: 0, describe: 0, dormant: 0 });
});

test('offers without refinement cannot create narrowing rules and low-level selection cannot introduce offers', () => {
  const ordinary = new ResourceOffer('ordinary', (source) => source);
  assert.throws(() => ordinary.refine(() => null), /does not support refinement/);
  const { offer } = fixture();
  const parent = bindResources({ ordinary: ordinary.request() }, [ordinary.provide(() => null)])(null);
  assert.throws(() => parent.select({ ordinary: ordinary.request() }, undefined, { input: null, refinements: [offer.refine(() => [])] }), /Refined resource is not requested/);
});

test('only offer-issued refinements are accepted; copied or fabricated rules cannot replace resource validation', () => {
  const { definition, options, operation, offer, counters } = fixture();
  const issued = offer.refine((input) => input.allowed);
  const forged = { offer: issued.offer, apply: () => ({ allowed: ['outside'] }) };
  const copied = { ...issued };
  const inherited = Object.create(issued);
  const requires = { bounded: offer.request() };
  const parent = bindResources(requires, [offer.provide((source) => source)])({ allowed: ['a'] });
  for (const rule of [forged, copied, inherited]) {
    assert.throws(() => bindChildResources(operation, [rule]), /not issued by an offer/);
    assert.throws(() => assembleRuntime(definition, { ...options, childResources: [{ definition: operation, refinements: [rule] }] }), /not issued by an offer/);
    assert.throws(() => parent.select(requires, requires, { input: { allowed: ['outside'] }, refinements: [rule] }), /not issued by an offer/);
  }
  assert.equal(issued.apply, undefined);
  assert.ok(Object.isFrozen(issued));
  assert.throws(() => {
    issued.offer = { name: 'substituted' };
  }, TypeError);
  assert.deepEqual(counters, { capture: 0, refine: 0, describe: 0, dormant: 0 });
  assert.throws(() => parent.select(requires, requires, { input: { allowed: ['outside'] }, refinements: [issued] }), /Cannot widen access/);
});
