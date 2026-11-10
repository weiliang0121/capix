import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionProgress } from '../dist/progress/buffer.js';
import { ProgressBudget } from '../dist/progress/budget.js';
import { unavailableProgressReader } from '../dist/progress/buffer.js';
import { validateProgressLimits } from '../dist/progress/buffer.js';

const immediate = { waitMs: 0 };

const wait = { waitMs: 1000 };

const text = (value) => {
  if (typeof value !== 'string') throw new TypeError('Expected text');
  return value;
};

const cursor = (id, sequence) => ({ interactionId: id, sequence });

test('process feedback replays and follows one shared ordered history with independent positions', async () => {
  const progress = new InteractionProgress('first', text);
  progress.publish('one');
  progress.publish('two');
  const first = progress.open();
  const second = progress.open(cursor('first', 1));
  assert.deepEqual(await first.next(immediate), { kind: 'item', cursor: cursor('first', 1), value: 'one' });
  assert.equal((await first.next(immediate)).value, 'two');
  assert.equal((await second.next(immediate)).value, 'two');
  const pending = first.next(wait);
  progress.publish('three');
  assert.equal((await pending).value, 'three');
  assert.equal((await second.next(immediate)).value, 'three');
  progress.seal();
  assert.deepEqual(await first.next(immediate), { kind: 'sealed', lastSequence: 3 });
  assert.deepEqual(await second.next(immediate), { kind: 'sealed', lastSequence: 3 });
});

test('sealed feedback drains all retained entries before reporting end', async () => {
  const progress = new InteractionProgress('finished', text);
  progress.publish('a');
  progress.publish('b');
  progress.seal();
  assert.equal(progress.publish('late').kind, 'sealed');
  const reader = progress.open();
  assert.equal((await reader.next(immediate)).value, 'a');
  assert.equal((await reader.next(immediate)).value, 'b');
  assert.deepEqual(await reader.next(immediate), { kind: 'sealed', lastSequence: 2 });
});

test('process feedback owns immutable data independently of the publishing object', async () => {
  const progress = new InteractionProgress('values', (value) => value);
  const original = { words: ['a'] };
  progress.publish(original);
  original.words.push('b');
  const reader = progress.open();
  const item = await reader.next(immediate);
  assert.deepEqual(item.value, { words: ['a'] });
  assert.ok(Object.isFrozen(item.value.words));
  assert.ok(Object.isFrozen(item));
  assert.ok(Object.isFrozen(item.cursor));
  reader.close();
});

test('UTF-8 encoded byte overflow invalidates the whole preview and wakes current readers', async () => {
  const budget = new ProgressBudget({ maxBytes: 10 });
  const progress = new InteractionProgress('bytes', text, { maxBytes: 5 }, budget);
  // The JSON string including quotes occupies five UTF-8 bytes.
  assert.equal(progress.publish('你').kind, 'published');
  const reader = progress.open();
  await reader.next(immediate);
  const pending = reader.next(wait);
  assert.deepEqual(progress.publish('x'), { kind: 'unavailable', reason: 'capacity' });
  assert.deepEqual(await pending, { kind: 'unavailable', reason: 'capacity' });
  assert.deepEqual(await progress.open().next(immediate), { kind: 'unavailable', reason: 'capacity' });
  assert.equal(progress.publish('ignored').kind, 'unavailable');
  assert.equal(budget.reserveBytes(10), true);
  budget.releaseBytes(10);
});

test('entry count bounds tiny chunks and invalidation releases readers and their shared budget', async () => {
  const budget = new ProgressBudget({ maxReaders: 1 });
  const first = new InteractionProgress('entries', text, { maxEntries: 1 }, budget);
  const reader = first.open();
  first.publish('');
  first.publish('');
  assert.deepEqual(await reader.next(immediate), { kind: 'unavailable', reason: 'capacity' });
  const other = new InteractionProgress('other', text, {}, budget).open();
  other.close();
  reader.close();
  first.invalidate('again');
});

test('shared byte exhaustion affects only the stream requesting more space', async () => {
  const budget = new ProgressBudget({ maxBytes: 6 });
  const first = new InteractionProgress('first', text, {}, budget);
  const second = new InteractionProgress('second', text, {}, budget);
  first.publish('aa');
  assert.equal(second.publish('bb').kind, 'unavailable');
  const reader = first.open();
  assert.equal((await reader.next(immediate)).value, 'aa');
  reader.close();
  first.invalidate('evicted');
  assert.equal(new InteractionProgress('third', text, {}, budget).publish('cccc').kind, 'published');
});

test('reader limits reject only the new reader and closing one releases its capacity', async () => {
  const budget = new ProgressBudget({ maxReaders: 2 });
  const first = new InteractionProgress('a', text, { maxReaders: 1 }, budget);
  const second = new InteractionProgress('b', text, {}, budget);
  const a = first.open();
  assert.throws(() => first.open(), { code: 'INTERACTION_PROGRESS_READERS' });
  const b = second.open();
  assert.throws(() => second.open(), { code: 'INTERACTION_PROGRESS_READERS' });
  a.close();
  a.close();
  const extra = second.open();
  second.publish('still working');
  assert.equal((await b.next(immediate)).value, 'still working');
  b.close();
  extra.close();
});

test('sealing an empty stream wakes readers and releases reader capacity', async () => {
  const budget = new ProgressBudget({ maxReaders: 1 });
  const progress = new InteractionProgress('a', text, {}, budget);
  const reader = progress.open();
  const pending = reader.next(wait);
  progress.seal();
  assert.deepEqual(await pending, { kind: 'sealed', lastSequence: 0 });
  const second = new InteractionProgress('b', text, {}, budget).open();
  second.close();
});

test('a reader supports one pending next and timeout does not terminate subsequent reading', async () => {
  const progress = new InteractionProgress('a', text);
  const reader = progress.open();
  const pending = reader.next({ waitMs: 5 });
  await assert.rejects(reader.next(wait), { code: 'INTERACTION_PROGRESS_CONCURRENT_READ' });
  assert.deepEqual(await pending, { kind: 'wait-expired' });
  progress.publish('later');
  assert.equal((await reader.next(immediate)).value, 'later');
  reader.close();
});

test('local close wakes a waiting read with the exact cause without changing the producer', async () => {
  const progress = new InteractionProgress('a', text);
  const reader = progress.open();
  const cause = new Error('window ended');
  const pending = reader.next(wait);
  reader.close(cause);
  await assert.rejects(pending, (error) => error === cause);
  assert.equal(progress.publish('after close').kind, 'published');
  const nextReader = progress.open();
  assert.equal((await nextReader.next(immediate)).value, 'after close');
  nextReader.close();
});

test('aborting a local wait preserves cancellation identity without closing the independent log', async () => {
  const progress = new InteractionProgress('a', text);
  const reader = progress.open();
  const control = new AbortController();
  const cause = new Error('cancel');
  const pending = reader.next({ ...wait, signal: control.signal });
  control.abort(cause);
  await assert.rejects(pending, (error) => error === cause);
  progress.publish('later');
  assert.equal((await reader.next(immediate)).value, 'later');
  reader.close();
});

test('eviction invalidates still-referenced history and wakes pending readers', async () => {
  const progress = new InteractionProgress('a', text);
  const reader = progress.open();
  const pending = reader.next(wait);
  progress.invalidate('not-retained');
  assert.deepEqual(await pending, { kind: 'unavailable', reason: 'not-retained' });
  assert.deepEqual(await reader.next(immediate), { kind: 'unavailable', reason: 'not-retained' });
});

test('read positions reject another interaction, invalid offsets and positions ahead of production', () => {
  const progress = new InteractionProgress('a', text);
  for (const after of [null, cursor('b', 0), cursor('a', undefined), cursor('a', null), cursor('a', -1), cursor('a', 1), cursor('a', 0.5), cursor('a', NaN)]) assert.throws(() => progress.open(after), { code: 'INTERACTION_PROGRESS_CURSOR' });
  assert.throws(() => unavailableProgressReader('a', 'restored', cursor('b', 0)), { code: 'INTERACTION_PROGRESS_CURSOR' });
});

test('unavailable restored streams retain the requested position and never invent empty history', async () => {
  const reader = unavailableProgressReader('a', 'restored', cursor('a', 12));
  assert.deepEqual(reader.position, cursor('a', 12));
  assert.deepEqual(await reader.next(immediate), { kind: 'unavailable', reason: 'restored' });
  reader.close();
  await assert.rejects(reader.next(immediate), { code: 'INTERACTION_PROGRESS_READER_CLOSED' });
});

test('invalid values and async codecs invalidate preview without leaking rejected promises', async () => {
  for (const decode of [
    () => {
      throw new Error('invalid');
    },
    () => Promise.reject(new Error('async codec')),
    () => ({ method() {} }),
  ]) {
    const progress = new InteractionProgress('a', decode);
    assert.equal(progress.publish('value').kind, 'unavailable');
    assert.deepEqual(await progress.open().next(immediate), { kind: 'unavailable', reason: 'invalid-data' });
  }
});

test('codec reentry cannot reorder entries, revive sealed state or revive invalidated data', async () => {
  let reentrant;
  reentrant = new InteractionProgress('reentrant', () => {
    reentrant.publish('nested');
    return 'outer';
  });
  assert.deepEqual(reentrant.publish('outer'), { kind: 'unavailable', reason: 'invalid-data' });
  let sealed;
  sealed = new InteractionProgress('sealed', (value) => {
    sealed.seal();
    return value;
  });
  assert.deepEqual(sealed.publish('outer'), { kind: 'sealed' });
  assert.deepEqual(await sealed.open().next(immediate), { kind: 'sealed', lastSequence: 0 });
  let invalidated;
  invalidated = new InteractionProgress('invalidated', (value) => {
    invalidated.invalidate('closed');
    return value;
  });
  assert.deepEqual(invalidated.publish('outer'), { kind: 'unavailable', reason: 'closed' });
});

test('configuration and invalid timer durations are rejected at their boundaries', async () => {
  for (const value of [0, -1, Infinity, 1.5]) {
    assert.throws(() => validateProgressLimits({ maxEntries: value }), RangeError);
    assert.throws(() => new ProgressBudget({ maxBytes: value }), RangeError);
  }
  const reader = new InteractionProgress('a', text).open();
  for (const waitMs of [-1, Infinity, 2 ** 31]) await assert.rejects(reader.next({ waitMs }), RangeError);
  reader.close();
});

test('a change between inspection and waiter registration cannot be lost', async () => {
  const progress = new InteractionProgress('race', text);
  const listen = progress.listen.bind(progress);
  let inject = true;
  progress.listen = (wake) => {
    if (inject) {
      inject = false;
      progress.publish('raced');
    }
    return listen(wake);
  };
  const reader = progress.open();
  assert.equal((await reader.next(wait)).value, 'raced');
  reader.close();
});

test('metadata observation reports installed lifecycle counts without preview content', async () => {
  const facts = [];
  const progress = new InteractionProgress('observed', text, {}, undefined, {
    receive: (fact) => {
      facts.push(fact);
    },
  });
  assert.deepEqual(facts, []);
  progress.installed();
  progress.installed();
  progress.publish('secret');
  const reader = progress.open();
  await reader.next(immediate);
  progress.seal();
  assert.deepEqual(
    facts.map((fact) => fact.phase),
    ['created', 'reader-opened', 'sealed', 'reader-closed'],
  );
  assert.equal(facts[1].bytes, 8);
  assert.equal(facts[1].lastSequence, 1);
  assert.equal(facts[3].readers, 0);
  assert.equal(JSON.stringify(facts).includes('secret'), false);
  assert.ok(facts.every(Object.isFrozen));
});

test('faulty and recursively mutating observers cannot damage installed feedback or loop', async () => {
  let progress;
  let errors = 0;
  progress = new InteractionProgress('reentry', text, {}, undefined, {
    receive: (fact) => {
      if (fact.phase === 'reader-opened') progress.invalidate('observer-invalidated');
    },
    failed: () => {
      errors += 1;
    },
  });
  progress.installed();
  progress.publish('before');
  const reader = progress.open();
  assert.equal(errors, 1);
  assert.deepEqual(await reader.next(immediate), { kind: 'unavailable', reason: 'observer-invalidated' });
  const safe = new InteractionProgress('safe', text, {}, undefined, {
    receive: () => {
      throw new Error('observer failed');
    },
  });
  safe.installed();
  assert.equal(safe.publish('still available').kind, 'published');
  safe.seal();
  const safeReader = safe.open();
  assert.equal((await safeReader.next(immediate)).value, 'still available');
  safeReader.close();
});

test('sealing from an invalidation observer cannot turn lost preview into a clean end', async () => {
  let progress;
  progress = new InteractionProgress('invalidation-reentry', text, { maxEntries: 1 }, undefined, {
    receive: (fact) => {
      if (fact.phase === 'unavailable') progress.seal();
    },
  });
  progress.installed();
  progress.publish('first');
  const reader = progress.open();
  assert.equal((await reader.next(immediate)).value, 'first');
  const pending = reader.next(wait);
  assert.deepEqual(progress.publish('overflow'), { kind: 'unavailable', reason: 'capacity' });
  assert.deepEqual(await pending, { kind: 'unavailable', reason: 'capacity' });
  assert.deepEqual(await reader.next(immediate), { kind: 'unavailable', reason: 'capacity' });
  assert.deepEqual(await progress.open().next(immediate), { kind: 'unavailable', reason: 'capacity' });
});

test('a throwing codec cannot replace prior invalidation with a sealed publication', () => {
  let progress;
  progress = new InteractionProgress('invalid-then-sealed', () => {
    progress.invalidate('not-retained');
    progress.seal();
    throw new Error('contract failed after closure');
  });
  assert.deepEqual(progress.publish('value'), { kind: 'unavailable', reason: 'not-retained' });
});
