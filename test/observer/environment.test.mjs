import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationContent, ObserverEnvironment, ObserverConversations, SqliteObserverStore, ModelInteractions, initializeObserver } from '@capix/observer-service';

const provider = {
  invoke() {
    throw new Error('This lifecycle test must not call a model');
  },
};

function persistedHost(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-environment-'));
  const store = SqliteObserverStore.open(join(directory, 'observer.sqlite'));
  const host = new ObserverConversations(provider, [], { persistence: store });
  t.after(() => {
    host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { host, store };
}

test('closing one environment releases its recording without closing borrowed conversation content', (t) => {
  const host = new ObserverConversations(provider);
  t.after(() => host.close());
  const id = host.list().defaultConversationId;
  const content = host.content(id);
  const environment = host.open(id);
  assert.ok(environment instanceof ObserverEnvironment);
  assert.ok(content instanceof ConversationContent);
  const messages = [];
  const stop = content.transcripts.connect((frame) => messages.push(frame));
  t.after(stop);
  const revision = environment.records.recorder.revision;
  environment.close();
  assert.equal(environment.closed, true);
  assert.equal(content.closed, false);
  assert.equal(host.content(id), content);
  assert.throws(() => host.open(id), { code: 'SERVICE_CLOSED' });
  assert.throws(() => host.peek(id), { code: 'SERVICE_CLOSED' });
  content.transcript.append({ role: 'user', content: 'The content lifetime continues' });
  content.consumer.flush();
  assert.equal(messages.at(-1).type, 'delta');
  assert.equal(messages.at(-1).event.change.messages[0].content, 'The content lifetime continues');
  assert.equal(environment.records.recorder.revision, revision, 'a detached recording never receives later content');
  host.close();
  assert.equal(content.closed, true);
});

test('standalone environment owns its content and closes idempotently', async (t) => {
  const environment = initializeObserver(provider);
  const content = environment.content;
  let closes = 0;
  const close = content.consumer.close.bind(content.consumer);
  t.mock.method(content.consumer, 'close', () => {
    closes++;
    close();
  });
  environment.close();
  environment.close();
  assert.equal(content.closed, true);
  assert.equal(closes, 1);
  await assert.rejects(environment.recover('missing'), { code: 'SERVICE_CLOSED' });
  assert.throws(() => initializeObserver(provider, [], { content }), { code: 'SERVICE_CLOSED' });
});

test('host shutdown finishes other environments and shared resources after one recording seal fails', (t) => {
  const { host, store } = persistedHost(t);
  const first = host.open(host.list().defaultConversationId);
  const second = host.open(host.create().id);
  const failure = new Error('First source cannot be sealed');
  const sealed = [];
  const seal = store.sealRecording.bind(store);
  t.mock.method(store, 'sealRecording', (id, revision) => {
    sealed.push(id);
    if (id === first.records.recorder.id) throw failure;
    seal(id, revision);
  });
  let databaseClosed = false;
  const close = store.close.bind(store);
  t.mock.method(store, 'close', () => {
    databaseClosed = true;
    close();
  });
  assert.throws(
    () => host.close(),
    (error) => error === failure,
  );
  assert.deepEqual(sealed, [first.records.recorder.id, second.records.recorder.id]);
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);
  assert.equal(first.content.closed, true);
  assert.equal(second.content.closed, true);
  assert.equal(databaseClosed, true);
  assert.throws(() => host.list(), { code: 'SERVICE_CLOSED' });
  assert.doesNotThrow(() => host.close());
});

test('environment reports all cleanup failures while still closing its owned persistence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-standalone-'));
  const store = SqliteObserverStore.open(join(directory, 'observer.sqlite'));
  const environment = initializeObserver(provider, [], { persistence: store });
  t.after(() => {
    environment.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const sealFailure = new Error('Seal failed');
  const contentFailure = new Error('Content close failed');
  t.mock.method(store, 'sealRecording', () => {
    throw sealFailure;
  });
  const closeContent = environment.content.close.bind(environment.content);
  t.mock.method(environment.content, 'close', () => {
    closeContent();
    throw contentFailure;
  });
  let databaseClosed = false;
  const closeStore = store.close.bind(store);
  t.mock.method(store, 'close', () => {
    databaseClosed = true;
    closeStore();
  });
  assert.throws(
    () => environment.close(),
    (error) => error instanceof AggregateError && error.errors[0] === sealFailure && error.errors[1] === contentFailure && error.errors.length === 2,
  );
  assert.equal(databaseClosed, true);
  assert.equal(environment.content.closed, true);
});

test('failed installation releases its own objects but preserves borrowed content and its existing observation', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const observed = [];
  content.observe({
    transcript: {
      publish: (event) => {
        observed.push(event);
      },
    },
    memory: { publish() {} },
  });
  const closedInteractions = [];
  const close = ModelInteractions.prototype.close;
  t.mock.method(ModelInteractions.prototype, 'close', function () {
    closedInteractions.push(this);
    close.call(this);
  });
  assert.throws(() => initializeObserver(provider, [], { content }), /already installed/);
  assert.equal(closedInteractions.length, 1);
  assert.equal(content.closed, false);
  content.transcript.append({ role: 'user', content: 'Still observed' });
  assert.equal(observed.at(-1).change.messages[0].content, 'Still observed');
});

test('failed initialization retains its original error when its own cleanup also fails', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  const original = new Error('Cannot install content observation');
  const cleanup = new Error('Cannot close interactions');
  t.mock.method(content, 'observe', () => {
    throw original;
  });
  t.mock.method(ModelInteractions.prototype, 'close', () => {
    throw cleanup;
  });
  assert.throws(
    () => initializeObserver(provider, [], { content }),
    (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === cleanup && error.errors.length === 2,
  );
  assert.equal(content.closed, false);
});

test('content shutdown closes its consumer even when transcript delivery cleanup fails', (t) => {
  const content = new ConversationContent();
  const feedFailure = new Error('Feed cleanup failed');
  const consumerFailure = new Error('Consumer cleanup failed');
  const closeFeed = content.transcripts.close.bind(content.transcripts);
  const closeConsumer = content.consumer.close.bind(content.consumer);
  let consumerClosed = false;
  t.mock.method(content.transcripts, 'close', () => {
    closeFeed();
    throw feedFailure;
  });
  t.mock.method(content.consumer, 'close', () => {
    closeConsumer();
    consumerClosed = true;
    throw consumerFailure;
  });
  assert.throws(
    () => content.close(),
    (error) => error instanceof AggregateError && error.errors[0] === feedFailure && error.errors[1] === consumerFailure && error.errors.length === 2,
  );
  assert.equal(content.closed, true);
  assert.equal(consumerClosed, true);
  assert.doesNotThrow(() => content.close());
});
