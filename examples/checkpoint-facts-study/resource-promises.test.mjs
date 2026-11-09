import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { MemoryResource } from '@weiliang0121/capix-memory';
import { Resource, ResourceAccessClosed, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
import { memoryBasis, memoryCreate, memoryFixture, memoryUpdate, resourceInvocation, resourceOwner } from './resource-promises.mjs';

function openMemory(t, fixture, contextId = 'resource-promises') {
  const facts = [];
  const access = fixture.binding.open(resourceOwner(contextId, facts));
  t.after(() => access.close());
  return { endpoint: access.endpoints.memories, facts, access };
}

const basisConflict = (error) => error instanceof RuntimeError && error.code === 'MEMORY_BASIS_CONFLICT';
const operationConflict = (error) => error instanceof RuntimeError && error.code === 'MEMORY_APPLY_CONFLICT';

test('an ordinary resource and a real Invocation need neither a basis, operation receipt nor checkpoint', async () => {
  const origin = new Map([['hello', '你好']]);
  const lookup = new ResourceOffer({ methods: { translate: (source, word) => source.get(word) ?? word } });
  const binding = new Resources().register(new Resource(origin), lookup).bind({ dictionary: lookup.request() });
  let retained;
  const probe = resourceInvocation(binding, (resources) => {
    retained = resources.dictionary;
    return retained.translate('hello');
  });
  assert.equal(await probe.invocation.run(), '你好');
  assert.equal(probe.invocation.context.status, 'succeeded');
  assert.deepEqual([...origin], [['hello', '你好']]);
  assert.equal('version' in origin, false);
  assert.equal('receipt' in origin, false);
  await assert.rejects(retained.translate('hello'), ResourceAccessClosed);
});

test('one access window permits overlapping local writes when the resource allows them', async (t) => {
  const origin = new Map();
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const gates = new Map([
    ['left', first],
    ['right', second],
  ]);
  const started = [];
  const completed = [];
  const patch = new ResourceOffer({
    methods: {
      async write(source, input) {
        started.push(input.key);
        await gates.get(input.key).promise;
        source.set(input.key, input.value);
        completed.push(input.key);
        return input.value;
      },
    },
  });
  const access = new Resources().register(new Resource(origin), patch).bind({ board: patch.request() }).open();
  t.after(() => access.close());
  const leftDraft = { key: 'left', value: 'L' };
  const rightDraft = { key: 'right', value: 'R' };
  const left = access.endpoints.board.write(Object.freeze({ ...leftDraft }));
  const right = access.endpoints.board.write(Object.freeze({ ...rightDraft }));
  assert.deepEqual(started, ['left', 'right']);
  assert.equal(origin.size, 0);
  second.resolve();
  assert.equal(await right, 'R');
  assert.deepEqual(completed, ['right']);
  first.resolve();
  assert.equal(await left, 'L');
  assert.deepEqual(
    [...origin],
    [
      ['right', 'R'],
      ['left', 'L'],
    ],
  );
  assert.deepEqual(completed, ['right', 'left']);
});

test('overlapping proposals sharing one Memory basis obey the resource conditional-write rule', async (t) => {
  const fixture = memoryFixture();
  const first = openMemory(t, fixture, 'first-writer');
  const second = openMemory(t, fixture, 'second-writer');
  const item = first.endpoint.apply([memoryCreate('original')]).items[0];
  const basis = memoryBasis(fixture.memories);
  const before = fixture.memories.get(item.id).snapshot();
  const firstGate = Promise.withResolvers();
  const secondGate = Promise.withResolvers();
  const firstDraft = memoryUpdate(item, 'first');
  const secondDraft = memoryUpdate(item, 'second');
  const firstWrite = firstGate.promise.then(() => first.endpoint.apply([firstDraft], basis));
  const secondWrite = secondGate.promise.then(() => second.endpoint.apply([secondDraft], basis));
  const secondRejected = assert.rejects(secondWrite, basisConflict);
  firstGate.resolve();
  assert.equal((await firstWrite).items[0].content, 'first');
  secondGate.resolve();
  await secondRejected;
  assert.equal(fixture.memories.get(item.id).content, 'first');
  assert.equal(before.content, 'original', 'the originally read stable value did not change');
  assert.equal(fixture.memories.sequence, 2);
  assert.equal(fixture.commits.length, 2);
  assert.equal(firstDraft.result.content, 'first');
  assert.equal(secondDraft.result.content, 'second');
});

test('Memory can reject an empty proposal against an obsolete basis; dirty=false cannot skip its contract', (t) => {
  const fixture = memoryFixture();
  const { endpoint } = openMemory(t, fixture);
  const basis = memoryBasis(fixture.memories);
  endpoint.apply([memoryCreate('new')], basis);
  const committed = fixture.commits.length;
  assert.throws(() => endpoint.apply([], basis), basisConflict);
  assert.equal(fixture.commits.length, committed);
  assert.equal(fixture.memories.sequence, 1);
});

test('a failed second resource leaves the first real entity effect in place after Invocation exit', async () => {
  const fixture = memoryFixture();
  const failure = new Error('the second resource rejected its operation');
  const origin = { attempts: 0 };
  const reject = new ResourceOffer({
    methods: {
      write(source) {
        source.attempts++;
        throw failure;
      },
    },
  });
  fixture.registry.register(new Resource(origin), reject);
  const binding = fixture.registry.bind({ memories: MemoryResource.apply.request(), destination: reject.request() });
  const probe = resourceInvocation(binding, async (resources) => {
    resources.memories.apply([memoryCreate('already installed')]);
    await resources.destination.write();
    return 'unreachable';
  });
  await assert.rejects(probe.invocation.run(), (error) => error === failure);
  assert.equal(probe.invocation.context.status, 'failed');
  assert.equal(origin.attempts, 1);
  assert.equal(fixture.commits.length, 1);
  assert.equal(fixture.memories.sequence, 1);
  assert.equal(fixture.memories.values()[0].content, 'already installed');
  assert.equal(fixture.events.length, 1);
});

test('Memory validates its own complete batch before committing; that boundary is not supplied by Invocation', (t) => {
  const fixture = memoryFixture();
  const { endpoint } = openMemory(t, fixture);
  const original = fixture.memories.exportState();
  const invalid = memoryUpdate({ id: 'missing-memory' }, 'invalid update');
  assert.throws(() => endpoint.apply([memoryCreate('otherwise valid'), invalid]), /target does not exist/);
  assert.deepEqual(fixture.memories.exportState(), original);
  assert.equal(fixture.commits.length, 0);
  assert.equal(fixture.events.length, 0);
});

test('an entity publication failure after a fixed commit fails the Invocation without undoing its content or receipt', async () => {
  const failure = new Error('content observer rejected publication');
  const fixture = memoryFixture({
    publish: () => {
      throw failure;
    },
  });
  const probe = resourceInvocation(fixture.binding, (resources) => resources.memories.applyFixed({ position: 'write', changes: [memoryCreate('committed before observation failed')] }));
  await assert.rejects(probe.invocation.run(), (error) => error === failure);
  assert.equal(probe.invocation.context.status, 'failed');
  assert.equal(fixture.commits.length, 1);
  assert.equal(fixture.memories.sequence, 1);
  assert.equal(fixture.memories.values()[0].content, 'committed before observation failed');
  const recorded = fixture.commits[0].fixed;
  assert.equal(recorded.request.operation.contextId, probe.invocation.context.id);
  assert.deepEqual(fixture.memories.confirmFixed(recorded.request), recorded.receipt);
  assert.equal(fixture.memories.exportState().applies.length, 1);
  assert.equal(probe.invocation.context.status, 'failed', 'entity confirmation does not revive a failed call');
  assert.equal(fixture.commits.length, 1);
});

test('an ordinary zero-change operation returns normally and has no required receipt protocol', async (t) => {
  const origin = { value: 'same' };
  const events = [];
  const offer = new ResourceOffer({ methods: { keep: (source) => source.value } });
  const access = new Resources().register(new Resource(origin), offer).bind({ value: offer.request() }).open(resourceOwner('zero-change', events));
  t.after(() => access.close());
  assert.equal(await access.endpoints.value.keep(), 'same');
  assert.equal(await access.endpoints.value.keep(), 'same');
  assert.deepEqual(origin, { value: 'same' });
  const returned = events.filter((event) => event.phase === 'returned');
  assert.equal(returned.length, 2, 'two operations returned despite identical content');
  assert.notEqual(returned[0].interactionId, returned[1].interactionId, 'resource observation operation IDs are not an effect-deduplication key');
});

test('ordinary unchanged Memory application creates no content version, persistence write or fixed receipt', (t) => {
  const fixture = memoryFixture();
  const { endpoint, facts } = openMemory(t, fixture);
  const item = endpoint.apply([memoryCreate('same')]).items[0];
  const original = fixture.memories.get(item.id).snapshot();
  const application = endpoint.apply([memoryUpdate(item, 'same')], memoryBasis(fixture.memories));
  assert.deepEqual(application.items, []);
  assert.equal(application.sequence, 1);
  assert.equal(application.startSequence, 1);
  assert.equal(fixture.memories.get(item.id).snapshot(), original);
  assert.equal(fixture.commits.length, 1);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.memories.exportState().applies, undefined);
  assert.equal(facts.filter((fact) => fact.phase === 'returned').length, 2);
});

test('fixed unchanged Memory application adds one explicit receipt while repeated confirmation adds nothing', (t) => {
  const fixture = memoryFixture();
  const { endpoint } = openMemory(t, fixture);
  const item = endpoint.apply([memoryCreate('same')]).items[0];
  const original = fixture.memories.get(item.id).snapshot();
  const basis = memoryBasis(fixture.memories);
  const request = { position: 'fixed-noop', changes: [memoryUpdate(item, 'same')] };
  const first = endpoint.applyFixed(request, basis);
  const repeated = endpoint.applyFixed(structuredClone(request), basis);
  assert.equal(first, repeated);
  assert.deepEqual(first, { memoriesId: fixture.memories.id, startSequence: 1, sequence: 1, memoryIds: [] });
  assert.equal(fixture.memories.get(item.id).snapshot(), original);
  assert.equal(fixture.memories.sequence, 1);
  assert.equal(fixture.commits.length, 2, 'initial content commit plus one receipt-only commit');
  assert.deepEqual(fixture.commits[1].upserts, []);
  assert.equal(fixture.events.length, 1, 'receipt-only commit does not fabricate a memory content event');
  assert.equal(fixture.memories.exportState().applies.length, 1);
});

test('public entity export/restore preserves exact old-effect confirmation after later writes', (t) => {
  const fixture = memoryFixture();
  const ownerId = 'original-applying-call';
  const { endpoint } = openMemory(t, fixture, ownerId);
  const basis = memoryBasis(fixture.memories);
  const request = { position: 'first-write', changes: [memoryCreate('first')] };
  const receipt = endpoint.applyFixed(request, basis);
  endpoint.apply([memoryCreate('later')]);
  const restored = memoryFixture({ transcript: fixture.transcript, state: structuredClone(fixture.memories.exportState()) });
  const restoredAccess = openMemory(t, restored, ownerId);
  assert.equal(restored.memories.sequence, 2);
  assert.deepEqual(restoredAccess.endpoint.applyFixed(structuredClone(request), basis), receipt);
  assert.equal(restored.commits.length, 0);
  assert.equal(restored.events.length, 0);
  assert.equal(restored.memories.values().length, 2);
  assert.throws(() => restoredAccess.endpoint.applyFixed({ position: request.position, changes: [memoryCreate('different')] }, basis), operationConflict);
  assert.equal(restored.commits.length, 0);
  assert.deepEqual(restored.memories.exportState(), fixture.memories.exportState());
});

test('ordinary Memory application does not implicitly deduplicate equal proposals or promise replay safety', (t) => {
  const fixture = memoryFixture();
  const { endpoint } = openMemory(t, fixture);
  const first = endpoint.apply([memoryCreate('equal value')]);
  const second = endpoint.apply([memoryCreate('equal value')]);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(fixture.memories.sequence, 2);
  assert.equal(fixture.commits.length, 2);
  assert.equal(fixture.memories.exportState().applies, undefined);
});
