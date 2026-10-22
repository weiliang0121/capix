import { Driver } from '@capix/server-runtime';
import { ModelInteractions, ModelSource } from '@capix/observer-service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { ProgressChannel, defineGroup } from '@capix/server-runtime';
import { ConversationSubmission, createSubmissionStore, buildConversation, createConversationStructure, ConversationGroup, acceptMessages } from '@capix/observer-service';
import { createEnvironment } from '../fixtures/environment.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const provider = {
  async invoke(_request, purpose) {
    return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'answer' }), finishReason: 'stop', usage: null };
  },
};
const input = { messages: [{ role: 'user', content: 'question' }] };
const complete = (submission) =>
  new Promise((resolve) => {
    let disconnect = () => {};
    disconnect = submission.connect((snapshot) => {
      if (snapshot.result) {
        disconnect();
        resolve(snapshot);
      }
    });
    if (submission.snapshot.result) disconnect();
  });

test('admission hint failure does not interrupt committed progress or terminal publication', async () => {
  let fail = false;
  const submission = new ConversationSubmission('hint-failed', 'conversation', {
    admission: () => {
      if (fail) throw new Error('hint unavailable');
      return { conversationId: 'conversation', transcriptId: 'transcript', status: 'ready' };
    },
  });
  submission.progress.publish({ kind: 'input', range: { transcriptId: 'transcript', start: 0, end: 1 } });
  assert.equal(submission.snapshot.admission.status, 'ready');
  fail = true;
  submission.progress.publish({ kind: 'answer', range: { transcriptId: 'transcript', start: 1, end: 2 } });
  assert.equal(submission.snapshot.admission, undefined, 'do not retain a stale ready hint');
  assert.equal(submission.snapshot.answer.index, 1);
  assert.equal(submission.snapshot.integrity.status, 'complete');
  submission.start(async () => 'done');
  const snapshot = await complete(submission);
  assert.equal(snapshot.result.status, 'completed');
  assert.equal(snapshot.admission, undefined);
  assert.ok(submission.endedAt !== undefined);
  await setTimeout(0);
});

test('service projection retains input committed before capture failure, without records or error reinterpretation', async () => {
  const environment = createEnvironment({
    changes: {
      capture() {
        throw new TypeError('capture failed after append');
      },
    },
  });
  const driver = new Driver();
  const scene = buildConversation(driver, createConversationStructure(), environment, new ModelInteractions(new ModelSource(provider)));
  const submission = new ConversationSubmission('append-failed', 'conversation');
  submission.start(() => driver.run(scene, input, { settings, progress: submission.progress }));
  const snapshot = await complete(submission);
  assert.equal(environment.transcript.length, 1);
  assert.deepEqual(snapshot.input, { transcriptId: environment.transcript.id, start: 0, end: 1, revision: 1 });
  assert.equal(snapshot.result.status, 'failed');
  assert.notEqual(snapshot.result.error.code, 'INVALID_INPUT');
  assert.deepEqual(snapshot.executions, []);
});

test('service input acceptance only classifies validation it actually owns', () => {
  let appended = false;
  assert.throws(
    () =>
      acceptMessages({ messages: [{ role: 'user', content: '' }] }, () => {
        appended = true;
      }),
    { code: 'INVALID_INPUT' },
  );
  assert.equal(appended, false);
  const error = new TypeError('late entity failure');
  assert.throws(
    () =>
      acceptMessages(input, () => {
        throw error;
      }),
    (actual) => actual === error,
  );
});

test('projection failure stops trustworthy progress but does not stop a running conversation', async () => {
  const environment = createEnvironment();
  const driver = new Driver();
  const scene = buildConversation(driver, createConversationStructure(), environment, new ModelInteractions(new ModelSource(provider)));
  const submission = new ConversationSubmission('broken-projection', 'conversation');
  // A second committed input cannot be interpreted as the same submission's input.
  submission.progress.publish({ kind: 'input', range: { transcriptId: environment.transcript.id, start: 0, end: 1, revision: 1 } });
  submission.start(() => driver.run(scene, input, { settings, progress: submission.progress }));
  const snapshot = await complete(submission);
  assert.equal(snapshot.integrity.status, 'incomplete');
  assert.equal(snapshot.result.status, 'completed');
  assert.equal(snapshot.input.end, 1);
  assert.equal(snapshot.answer, undefined, 'an incomplete projection must not pretend that later facts repair its source');
  assert.equal(environment.transcript.length, 2);
});

test('connection listeners execute outside producers and failed listeners cannot affect other delivery', async () => {
  const submission = new ConversationSubmission('listeners', 'conversation');
  const channel = submission.progress;
  const snapshots = [];
  let insideProducer = false;
  submission.connect(() => {
    throw new Error('disconnected writer');
  });
  submission.connect((snapshot) => {
    assert.equal(insideProducer, false);
    snapshots.push(snapshot);
  });
  insideProducer = true;
  channel.publish({ kind: 'input', range: { transcriptId: 'transcript', start: 0, end: 1, revision: 1 } });
  insideProducer = false;
  submission.start(async () => {});
  await complete(submission);
  assert.equal(channel.failure, undefined);
  assert.equal(snapshots.at(-1).result.status, 'completed');
  assert.equal(snapshots.at(-1).input.end, 1);
});

test('bounded retention never evicts active work, expires completed progress, and prevents retained duplicate submissions', async () => {
  const store = createSubmissionStore({ maxEntries: 1, ttlMs: 10 });
  const first = store.create('first', 'conversation');
  let release;
  first.start(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  assert.throws(() => store.create('first', 'conversation'), { code: 'SUBMISSION_EXISTS' });
  assert.throws(() => store.create('second', 'conversation'), { code: 'SUBMISSION_CAPACITY' });
  assert.equal(store.get('first'), first);
  release();
  await complete(first);
  const second = store.create('second', 'conversation');
  assert.equal(store.get('first'), undefined);
  second.start(async () => {});
  await complete(second);
  await setTimeout(15);
  assert.equal(store.get('second'), undefined);
});

test('active discovery follows the service lifetime even when projection fails, and excludes refused or settled work', async () => {
  const store = createSubmissionStore();
  const refused = store.create('refused', 'conversation');
  refused.reject(new Error('not accepted'));
  assert.equal(store.active('conversation'), undefined);
  const active = store.create('active', 'conversation');
  let finish;
  active.start(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  active.progress.publish({ kind: 'input', range: { transcriptId: 'transcript', start: 0, end: 1 } });
  active.progress.publish({ kind: 'input', range: { transcriptId: 'transcript', start: 1, end: 2 } });
  assert.equal(active.snapshot.integrity.status, 'incomplete');
  assert.equal(store.active('conversation'), active);
  assert.equal(store.active('other'), undefined);
  finish();
  await complete(active);
  assert.equal(store.active('conversation'), undefined);
  assert.equal(store.get('active'), active, 'completion retains ID lookup until eviction');
});

test('conversation binding selects its declared E instead of giving every R child the same public meaning', async () => {
  const environment = createEnvironment();
  const definition = createConversationStructure();
  const other = defineGroup()({ members: [], run: { execute: () => null } });
  const originalRun = definition.scene.run;
  definition.scene.add(other);
  definition.scene.setRun({
    ...originalRun,
    uses: definition.scene.members,
    execute: async (work) => {
      const unrelated = work.children.create(other, work.input, { key: 'unrelated' });
      await unrelated.run();
      await unrelated.accept(() => undefined);
      return originalRun.execute(work);
    },
  });
  const driver = new Driver();
  const scene = buildConversation(driver, definition, environment, new ModelInteractions(new ModelSource(provider)));
  const received = [];
  await driver.run(scene, input, {
    settings,
    progress: new ProgressChannel({
      receive(fact) {
        received.push(fact);
      },
    }),
  });
  assert.equal(environment.transcript.length, 2);
  assert.deepEqual(
    received.map((fact) => fact.kind),
    ['input', 'execution', 'task', 'answer'],
  );
  assert.equal(received[0].range.start, 0);
  assert.equal(received.at(-1).range.start, 1);
});

test('async delivery listeners are isolated and readiness cancellation only detaches that waiter', async () => {
  const submission = new ConversationSubmission('async-listener', 'conversation');
  submission.connect(async () => {
    throw new Error('async consumer rejected');
  });
  const waiting = new AbortController();
  const ready = submission.ready(waiting.signal);
  waiting.abort(new Error('HTTP connection closed'));
  await assert.rejects(ready, /HTTP connection closed/);
  submission.start(async () => {});
  assert.equal((await complete(submission)).result.status, 'completed');
  await setTimeout(0);
});

test('a single submission channel disables its consumer across input, execution and answer sources', async () => {
  const environment = createEnvironment();
  const driver = new Driver();
  const scene = buildConversation(driver, createConversationStructure(), environment, new ModelInteractions(new ModelSource(provider)));
  const received = [];
  const failures = [];
  const failure = new Error('input projection failed');
  const progress = new ProgressChannel({
    receive(fact) {
      received.push(fact.kind);
      throw failure;
    },
    failed(error) {
      failures.push(error);
    },
  });
  const output = await driver.run(scene, input, { settings, progress });
  assert.equal(output.content, 'answer');
  assert.deepEqual(received, ['input']);
  assert.deepEqual(failures, [failure]);
  assert.equal(environment.transcript.length, 2);
  const next = [];
  await driver.run(scene, input, {
    settings,
    progress: new ProgressChannel({
      receive(fact) {
        next.push(fact.kind);
      },
    }),
  });
  assert.deepEqual(next, ['input', 'execution', 'task', 'answer'], 'a new call owns its own channel and does not inherit earlier failures');
});

test('pre-runtime rejection is terminal, queryable, and cannot subsequently start work', async () => {
  const submission = new ConversationSubmission('pre-rejected', 'conversation');
  submission.reject(new Error('invalid request settings'));
  assert.equal(submission.snapshot.result.status, 'rejected');
  assert.equal(submission.snapshot.input, undefined);
  assert.equal(submission.snapshot.revision, 1);
  assert.ok(submission.endedAt !== undefined);
  assert.throws(() => submission.start(async () => assert.fail('rejected work must never run')), /already started or ended/);
  assert.throws(() => submission.reject(new Error('again')), /Cannot reject/);
  const active = new ConversationSubmission('already-started', 'conversation');
  active.start(async () => {});
  assert.throws(() => active.reject(new Error('too late')), /Cannot reject/);
  await complete(active);
});

test('cancellation is idempotent and waits for work to settle instead of releasing on request', async () => {
  const submission = new ConversationSubmission('cooperative-cancel', 'conversation');
  let receivedSignal;
  let release;
  submission.start((signal) => {
    receivedSignal = signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const requested = submission.requestCancellation();
  assert.equal(requested.cancelRequested, true);
  assert.equal(requested.result, undefined);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(submission.endedAt, undefined);
  assert.equal(submission.requestCancellation(), requested);
  release();
  const result = await complete(submission);
  assert.equal(result.result.status, 'completed', 'a request alone does not convert successful work into cancellation');
  assert.equal(result.cancelRequested, true);
  assert.equal(submission.requestCancellation(), result);
});

test('only runtime-confirmed cancellation terminates as cancelled and keeps committed content', async () => {
  const environment = createEnvironment();
  let entered;
  let release;
  let providerSignal;
  const entering = new Promise((resolve) => {
    entered = resolve;
  });
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const interactions = new ModelInteractions(
    new ModelSource({
      async invoke(_request, _purpose, signal) {
        providerSignal = signal;
        entered();
        await response;
        return provider.invoke(_request, _purpose);
      },
    }),
  );
  const driver = new Driver();
  const scene = buildConversation(driver, createConversationStructure(), environment, interactions);
  const submission = new ConversationSubmission('confirmed-cancel', 'conversation');
  try {
    submission.start((signal) => driver.run(scene, input, { settings, progress: submission.progress, activity: submission.activity, signal }));
    await entering;
    submission.requestCancellation();
    const result = await complete(submission);
    assert.equal(result.result.status, 'cancelled');
    assert.equal(result.cancelRequested, true);
    assert.equal(result.input.end, 1);
    assert.equal(result.activities.integrity.status, 'complete');
    assert.equal(result.activities.calls.find((call) => call.kind === 'scene').status, 'cancelled');
    assert.ok(result.activities.calls.some((call) => call.kind === 'node' && call.status === 'cancelled'));
    assert.equal(environment.transcript.length, 1);
    assert.equal(driver.isRunning(scene), false);
    assert.equal(providerSignal.aborted, false);
    assert.equal(interactions.active, true);
    release();
    await interactions.settled();
    assert.equal(interactions.active, false);
    assert.equal(environment.transcript.length, 1);
    assert.equal(submission.snapshot.result.status, 'cancelled');
  } finally {
    release();
    await interactions.settled();
    interactions.close();
  }
});

test('an independent failure after a cancellation request remains a failure', async () => {
  const submission = new ConversationSubmission('failed-with-cancel', 'conversation');
  let rejectWork;
  submission.start(
    () =>
      new Promise((_resolve, reject) => {
        rejectWork = reject;
      }),
  );
  submission.requestCancellation();
  rejectWork(new Error('independent work failure'));
  const result = await complete(submission);
  assert.equal(result.cancelRequested, true);
  assert.equal(result.result.status, 'failed');
  assert.equal(result.result.error.code, 'INTERNAL_ERROR');
});

test('late cancellation never changes an already completed or rejected submission', async () => {
  const completed = new ConversationSubmission('completed-before-cancel', 'conversation');
  completed.start(async () => undefined);
  const snapshot = await complete(completed);
  assert.equal(completed.requestCancellation(), snapshot);
  assert.equal(snapshot.cancelRequested, undefined);
  const rejected = new ConversationSubmission('rejected-before-cancel', 'conversation');
  rejected.reject(new Error('not accepted'));
  const refusal = rejected.snapshot;
  assert.equal(rejected.requestCancellation(), refusal);
  assert.equal(refusal.cancelRequested, undefined);
});
