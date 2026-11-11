import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Memories, MemoryFacts, memoryResources } from '@weiliang0121/capix-memory';
import { Resource, Resources, ResourceAccessClosed } from '@weiliang0121/capix-resources';
import { StableValueError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

const create = (content, metadata) => ({ action: 'create', value: { content, ...(metadata === undefined ? {} : { metadata }) } });
const update = (item, content) => ({ action: 'update', memoryId: item.id, value: { content } });
const basis = (memories) => memories.snapshot().basis;

function open(memories, publish = () => {}) {
  const offers = memoryResources();
  const facts = [];
  const access = new Resources()
    .register(new Resource(memories), offers.apply)
    .register(new Resource(memories), offers.read)
    .bind({ memory: offers.apply.request(), read: offers.read.request() })
    .open({
      contextId: 'memory-application',
      failures: { isProtected: (error) => error instanceof PersistenceError, isCancellation: () => false, describe: (error) => ({ message: error.message }) },
      validate() {},
      observation: {
        publish(fact) {
          facts.push(fact);
          publish(fact);
        },
      },
      facts: {
        publish(fact) {
          facts.push(fact);
        },
      },
    });
  return { access, endpoint: access.endpoints.memory, reader: access.endpoints.read, facts };
}

test('resource writes return only fixed changed items and reads explicitly capture current content', () => {
  const memories = new Memories();
  const { access, endpoint, reader } = open(memories);
  const original = basis(memories);
  const proposed = create('one', { tags: ['a'] });
  const first = endpoint.apply([proposed, create('two')], original);
  assert.deepEqual(first.before, original);
  assert.equal(first.after.sequence, 2);
  assert.deepEqual(first.changed, memories.values());
  const [one, two] = first.changed;
  const captured = reader.read(one.id);
  proposed.value.metadata.tags.push('mutated');
  const second = endpoint.apply([update(one, 'one'), update(two, 'changed')]);
  assert.equal(second.changed.length, 2, 'removing metadata changes content');
  assert.equal(captured.value.content, 'one');
  assert.deepEqual(captured.value.metadata.tags, ['a']);
  assert.equal(Object.isFrozen(captured.value.metadata.tags), true);
  assert.deepEqual(reader.snapshot(), memories.snapshot());
  assert.equal(reader.read('absent'), undefined);
  assert.equal(reader.read(two.id).value.content, 'changed');
  access.close();
  assert.throws(() => reader.read(one.id), ResourceAccessClosed);
  assert.throws(() => reader.snapshot(), ResourceAccessClosed);
  assert.throws(() => endpoint.apply([]), ResourceAccessClosed);
  assert.equal(captured.value.content, 'one');
});

test('read binding and single reads do not enumerate all content', () => {
  const memories = new Memories();
  const [item] = memories.apply([create('single')]).changed;
  memories.snapshot = () => assert.fail('single read must not take a snapshot');
  memories.values = () => assert.fail('single read must not enumerate');
  const { access, reader } = open(memories);
  assert.equal(reader.read(item.id).value.content, 'single');
  access.close();
});

test('entity checks stale and foreign bases inside the actual operation, even for empty writes', () => {
  const memories = new Memories();
  const stale = basis(memories);
  let injected = false;
  const { access, endpoint } = open(memories, (fact) => {
    if (fact.phase === 'started' && !injected) {
      injected = true;
      memories.apply([create('concurrent')]);
    }
  });
  assert.throws(() => endpoint.apply([create('stale')], stale), { code: 'MEMORY_BASIS_CONFLICT' });
  assert.throws(() => endpoint.apply([], stale), { code: 'MEMORY_BASIS_CONFLICT' });
  assert.throws(() => endpoint.apply([], { ...basis(memories), memoriesId: new Memories().id }), { code: 'MEMORY_BASIS_CONFLICT' });
  assert.equal(memories.sequence, 1);
  access.close();
});

test('accessor basis is rejected without reentrant writes', () => {
  const memories = new Memories();
  const { access, endpoint } = open(memories);
  let reads = 0;
  const expected = {
    memoriesId: memories.id,
    get sequence() {
      reads++;
      memories.apply([create('injected')]);
      return 0;
    },
  };
  assert.throws(() => endpoint.apply([create('proposal')], expected), StableValueError);
  assert.equal(reads, 0);
  assert.equal(memories.sequence, 0);
  access.close();
});

test('fixed operations confirm original request and basis after later writes', () => {
  let commits = 0;
  const memories = new Memories({
    persistence: {
      commit() {
        commits++;
      },
    },
  });
  const { access, endpoint } = open(memories);
  const expected = basis(memories);
  const input = { position: 'maintenance', changes: [create('fixed')] };
  const receipt = endpoint.applyFixed(input, expected);
  assert.deepEqual(receipt.changes, [{ commandIndex: 0, memoryId: memories.values()[0].id }]);
  endpoint.apply([create('later')]);
  assert.equal(endpoint.applyFixed(input, expected), receipt);
  assert.equal(commits, 2);
  assert.throws(() => endpoint.applyFixed(input, basis(memories)), { code: 'MEMORY_APPLY_CONFLICT' });
  assert.throws(() => endpoint.applyFixed({ ...input, changes: [{ ...create('fixed'), reason: 'different request' }] }, expected), { code: 'MEMORY_APPLY_CONFLICT' });
  assert.throws(() => endpoint.applyFixed({ ...input, position: 'absent' }, expected), { code: 'MEMORY_BASIS_CONFLICT' });
  const emptyBasis = basis(memories);
  const empty = { position: 'empty', changes: [] };
  const emptyReceipt = endpoint.applyFixed(empty, emptyBasis);
  assert.equal(emptyReceipt.startSequence, emptyReceipt.sequence);
  assert.deepEqual(emptyReceipt.changes, []);
  assert.equal(endpoint.applyFixed(empty, emptyBasis), emptyReceipt);
  assert.equal(commits, 3);
  access.close();
});

test('facts retain exact operation provenance and metadata while operation descriptions omit content', () => {
  const memories = new Memories();
  const { access, endpoint, facts } = open(memories);
  endpoint.apply([create('private content', { label: 'private metadata' })]);
  const domain = [];
  for (const fact of facts) if ('fact' in fact) MemoryFacts.match(fact.fact, (event) => domain.push({ event, fact }));
  assert.equal(domain.length, 1);
  assert.equal(domain[0].event.change.value.content, 'private content');
  assert.deepEqual(domain[0].event.change.value.metadata, { label: 'private metadata' });
  assert.equal(domain[0].fact.operationId, facts.find((fact) => fact.phase === 'started').interactionId);
  assert.equal(domain[0].event.origin.contextId, domain[0].fact.contextId);
  assert.equal(domain[0].event.origin.contextId, 'memory-application');
  const operations = facts.filter((fact) => fact.phase === 'started' || fact.phase === 'returned').map((fact) => fact.describe());
  assert.equal(JSON.stringify(operations).includes('private'), false);
  access.close();
});

test('closing the access during started observation prevents entity mutation', () => {
  const memories = new Memories();
  const { access, endpoint } = open(memories, (fact) => {
    if (fact.phase === 'started') access.close();
  });
  assert.throws(() => endpoint.apply([create('closed')]), ResourceAccessClosed);
  assert.equal(memories.sequence, 0);
});

test('fixed input accessors never run, including through interested operation observers', () => {
  const memories = new Memories();
  const { access, endpoint } = open(memories, (fact) => fact.describe());
  let getters = 0;
  const inject = () => {
    getters++;
    memories.apply([create('injected')]);
    return 'position';
  };
  assert.throws(
    () =>
      endpoint.applyFixed({
        get position() {
          return inject();
        },
        changes: [],
      }),
    StableValueError,
  );
  assert.throws(
    () =>
      endpoint.applyFixed({
        position: 'position',
        get changes() {
          inject();
          return [];
        },
      }),
    StableValueError,
  );
  assert.equal(getters, 0);
  assert.equal(memories.sequence, 0);
  assert.deepEqual(memories.values(), []);
  access.close();
});

test('ordinary write descriptions do not inspect raw arrays before the entity guard', () => {
  const memories = new Memories();
  const { access, endpoint } = open(memories, (fact) => fact.describe());
  let lengthReads = 0;
  const commands = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') {
        lengthReads++;
        memories.apply([create('unguarded')]);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  try {
    assert.deepEqual(endpoint.apply(commands).changed, []);
    assert.equal(lengthReads, 0);
    assert.equal(memories.sequence, 0);
  } finally {
    access.close();
  }
});

for (const location of ['command', 'metadata']) {
  test(`fixed ${location} Proxy inspection runs inside the entity mutation guard`, () => {
    const memories = new Memories();
    const { access, endpoint } = open(memories, (fact) => fact.describe());
    let attempts = 0;
    const guarded = (value) =>
      new Proxy(value, {
        ownKeys(target) {
          attempts++;
          assert.throws(() => memories.apply([create('nested')]), /reenter|mutation/i);
          return Reflect.ownKeys(target);
        },
      });
    const input = location === 'command' ? guarded({ position: 'guarded', changes: [] }) : { position: 'guarded', changes: [create('accepted', guarded({ label: 'fixed' }))] };
    try {
      const receipt = endpoint.applyFixed(input);
      assert.equal(attempts, 1);
      assert.equal(memories.sequence, location === 'command' ? 0 : 1);
      assert.equal(endpoint.applyFixed(input), receipt);
      assert.equal(
        memories.values().some((item) => item.value.content === 'nested'),
        false,
      );
    } finally {
      access.close();
    }
  });
}
