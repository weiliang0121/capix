import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clock } from '@capix/server-runtime';
import { ConversationContent } from '@capix/observer-content';
import { ObserverRecording } from '@capix/observer-service';

function recording(content, persistence) {
  return new ObserverRecording(content.changes, content.consumer, { clock: new Clock(), persistence, conversationId: 'conversation' });
}

function sourceSubscriptions(t, content) {
  const counts = { attached: 0, detached: 0 };
  const subscribe = content.consumer.subscribe.bind(content.consumer);
  t.mock.method(content.consumer, 'subscribe', (listener) => {
    counts.attached++;
    const detach = subscribe(listener);
    return () => {
      counts.detached++;
      detach();
    };
  });
  return counts;
}

test('recording history corruption disables observation without taking ownership of healthy content', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const operations = [];
  const records = recording(content, {
    loadRecording() {
      throw new Error('corrupt archive');
    },
    openRecording(id) {
      operations.push(['open', id]);
    },
    applyRecordChange() {},
    sealRecording(id) {
      operations.push(['seal', id]);
    },
    invalidateRecording() {
      assert.fail('normal shutdown does not invalidate the new recording');
    },
  });
  assert.equal(records.book, records.recorder.book);
  assert.throws(() => records.source.assertComplete(), { code: 'SOURCE_INCOMPLETE' });
  records.close();
  records.close();
  assert.deepEqual(operations, [
    ['open', records.recorder.id],
    ['seal', records.recorder.id],
  ]);
  assert.equal(content.closed, false);
  content.transcript.append({ role: 'user', content: 'still usable' });
  assert.equal(content.transcript.length, 1);
});

test('database failure during history loading is strict and installs no recording listener', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const counts = sourceSubscriptions(t, content);
  const failure = new Error('database unavailable');
  assert.throws(
    () =>
      recording(content, {
        failure,
        loadRecording() {
          throw failure;
        },
        openRecording() {
          assert.fail('cannot open a recording after database failure');
        },
      }),
    (error) => error === failure,
  );
  assert.deepEqual(counts, { attached: 0, detached: 0 });
  assert.equal(content.closed, false);
});

test('recording open failure releases exactly its own listener and does not claim an opened session', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const counts = sourceSubscriptions(t, content);
  const failure = new Error('cannot open recording');
  assert.throws(
    () =>
      recording(content, {
        loadRecording: () => ({ book: { entries: [] }, archives: [] }),
        openRecording() {
          throw failure;
        },
        invalidateRecording() {
          assert.fail('no session was opened');
        },
      }),
    (error) => error === failure,
  );
  assert.deepEqual(counts, { attached: 1, detached: 1 });
  assert.equal(content.closed, false);
});

test('recording invalidation still terminates the source if persisting its failure marker throws', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const markerFailure = new Error('marker write failed');
  const records = recording(content, {
    loadRecording: () => ({ book: { entries: [] }, archives: [] }),
    openRecording() {},
    applyRecordChange() {},
    invalidateRecording() {
      throw markerFailure;
    },
    sealRecording() {},
  });
  assert.throws(
    () => records.invalidate(new Error('missed record')),
    (error) => error === markerFailure,
  );
  assert.throws(() => records.source.assertComplete(), { code: 'SOURCE_INCOMPLETE' });
  records.close();
  assert.equal(content.closed, false);
});

test('normal recording close releases its listener even when sealing fails, without invalidating it', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const counts = sourceSubscriptions(t, content);
  const failure = new Error('seal failed');
  const records = recording(content, {
    loadRecording: () => ({ book: { entries: [] }, archives: [] }),
    openRecording() {},
    applyRecordChange() {},
    sealRecording() {
      throw failure;
    },
    invalidateRecording() {
      assert.fail('normal shutdown is not an incomplete observation');
    },
  });
  assert.throws(
    () => records.close(),
    (error) => error === failure,
  );
  assert.deepEqual(counts, { attached: 1, detached: 1 });
  assert.doesNotThrow(() => records.close());
  assert.equal(content.closed, false);
});

test('a falsy history error still permanently invalidates optional observation', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const records = recording(content, {
    loadRecording() {
      throw undefined;
    },
    openRecording() {},
    applyRecordChange() {},
    sealRecording() {},
  });
  assert.throws(() => records.source.assertComplete(), { code: 'SOURCE_INCOMPLETE' });
  records.close();
  assert.equal(content.closed, false);
});
