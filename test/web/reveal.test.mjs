import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataProjection } from '../../apps/observer/.test-dist/binding/data.js';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';
import { installFrames } from './frames.mjs';

const transcriptId = 'reveal-transcript';
const user = { role: 'user', content: '问题' };
const answer = { role: 'assistant', content: '**完整回答**，正式正文不会被显示游标截断。' };
const initial = () => ({ ...client({ conversation: transport() }).getSnapshot(), transcriptId });
const submission = (id, index, patch = {}) => ({ id, queueId: `local-${id}`, pending: user.content, feedback: { status: 'following' }, remote: submissionSnapshot(id, { input: { transcriptId, start: index - 1, end: index }, answer: { transcriptId, index }, ...patch }) });
const tracked = (...values) => new Map(values.map((value) => [value.id, value]));
const messagesOf = (data) => data.conversation.flatMap((item) => (item.kind === 'message' ? [item] : item.kind === 'response' && item.body ? [item.body] : []));
const eligible = (data) =>
  messagesOf(data)
    .filter((row) => row.reveal)
    .map((row) => row.index);

test('initial history and submissions already tracked at presentation start remain static', () => {
  const value = submission('existing', 1, { result: { status: 'completed' } });
  const state = { ...initial(), messages: [user, answer], submission: value, submissions: tracked(value) };
  const project = createDataProjection();
  assert.deepEqual(eligible(project(state)), []);
  assert.deepEqual(eligible(project({ ...state, submission: { ...value, feedback: { status: 'ended' } } })), []);
  assert.deepEqual(eligible(createDataProjection()(state)), [], 'reconnecting the presentation does not replay history');
});

test('new local submissions identify answers by formal locator without observation or text matching', () => {
  const state = initial();
  const project = createDataProjection();
  project({ ...state, messages: [user, answer] });
  const value = submission('new', 3);
  const data = project({ ...state, messages: [user, answer, user, answer], submission: value, submissions: tracked(value) });
  assert.deepEqual(eligible(data), [3]);
  assert.equal(messagesOf(data)[3].message, answer);
  assert.equal(messagesOf(data)[3].message.content, answer.content);
  assert.equal(messagesOf(data)[3].executionId, undefined);
  assert.equal(data.busy, state.busy, 'playback eligibility does not change command or submission state');
});

test('formal content displayed before its answer locator arrives never flashes back into playback', () => {
  const state = initial();
  const project = createDataProjection();
  project(state);
  const pending = submission('new', 1, { answer: undefined });
  assert.deepEqual(eligible(project({ ...state, messages: [user, answer], submission: pending, submissions: tracked(pending) })), []);
  const located = submission('new', 1);
  assert.deepEqual(eligible(project({ ...state, messages: [user, answer], submission: located, submissions: tracked(located) })), []);
});

test('an answer locator arriving first grants playback only when its matching formal body becomes available', () => {
  const state = initial();
  const project = createDataProjection();
  project(state);
  const value = submission('new', 1);
  const pending = project({ ...state, messages: [user], submission: value, submissions: tracked(value) });
  assert.equal(messagesOf(pending).length, 1);
  assert.deepEqual(eligible(pending), []);
  assert.deepEqual(eligible(project({ ...state, messages: [user, answer], submission: value, submissions: tracked(value) })), [1]);
});

test('wrong collection, user messages and untracked additions cannot become animated answers', () => {
  const state = initial();
  const project = createDataProjection();
  project(state);
  const wrongCollection = submission('wrong-collection', 1, { answer: { transcriptId: 'elsewhere', index: 1 } });
  const wrongRole = submission('wrong-role', 0);
  const data = project({ ...state, messages: [user, answer, user, answer], submissions: tracked(wrongCollection, wrongRole) });
  assert.deepEqual(eligible(data), []);
});

test('a synchronization gap makes subsequently recovered content static without interrupting available playback', () => {
  const state = initial();
  const project = createDataProjection();
  project(state);
  const first = submission('first', 1);
  const second = submission('second', 3);
  const values = tracked(first, second);
  assert.deepEqual(eligible(project({ ...state, messages: [user, answer], submissions: values })), [1]);
  const interrupted = new Map([[transcriptId, { sync: { status: 'retrying', attempt: 1, retryAt: 1000, error: new Error('断流') } }]]);
  assert.deepEqual(eligible(project({ ...state, messages: [user, answer], submissions: values, transcripts: interrupted })), [1]);
  const reconnected = new Map([[transcriptId, { sync: { status: 'live' } }]]);
  assert.deepEqual(eligible(project({ ...state, messages: [user, answer, user, answer], submissions: values, transcripts: reconnected })), [1]);
});

test('completed and cancelled submissions retain independent answer eligibility while tracked', () => {
  const state = initial();
  const project = createDataProjection();
  project(state);
  const first = submission('first', 1, { result: { status: 'completed' } });
  const second = submission('second', 3, { result: { status: 'cancelled' }, cancelRequested: true });
  const messages = [user, answer, user, answer];
  const data = project({ ...state, messages, submissions: tracked(first, second) });
  assert.deepEqual(eligible(data), [1, 3]);
  assert.deepEqual(eligible(project({ ...state, messages, submissions: tracked(second) })), [3], 'expired tracked submissions release eligibility');
});

test('stable facts reuse read models and a collection switch starts a static history view', () => {
  const state = initial();
  const project = createDataProjection();
  project(state);
  const value = submission('new', 1);
  const current = { ...state, messages: [user, answer], submissions: tracked(value) };
  const data = project(current);
  const unchanged = project({ ...current, queue: { ...current.queue, waiting: [{ id: 'queued', pending: '稍后' }] } });
  assert.equal(unchanged.conversation, data.conversation);
  assert.equal(messagesOf(unchanged)[1], messagesOf(data)[1]);
  const switched = project({ ...current, transcriptId: 'another-collection' });
  assert.deepEqual(eligible(switched), []);
  assert.notEqual(messagesOf(switched)[1].key, messagesOf(data)[1].key);
  assert.deepEqual(eligible(project(current)), [], 'returning to a previously displayed collection does not replay its history');
});

test('multiple local submissions completed within one frame retain distinct playback identities', async (t) => {
  const frames = installFrames(t);
  const io = transport({
    submit: async (request, receive) => {
      const delivery = io.delivery(request, receive);
      delivery.input();
      delivery.answer(answer.content);
      delivery.complete();
    },
  });
  const runtime = client({ conversation: io });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  t.after(disconnect);
  await runtime.initialize();
  await runtime.submit({ messages: [user] });
  await runtime.submit({ messages: [user] });
  await frames.flush();
  const data = app.store.getState().data;
  assert.deepEqual(eligible(data), [1, 3]);
  assert.notEqual(messagesOf(data)[1].key, messagesOf(data)[3].key);
  assert.equal(messagesOf(data)[1].message.content, answer.content);
  assert.equal(messagesOf(data)[3].message.content, answer.content);
  assert.equal(runtime.getSnapshot().observation.enabled, false);
});

test('admission attempts retain local playback identity and cannot replay an existing queue item after reconnect', () => {
  const state = initial();
  const first = { ...submission('first-attempt', 1, { input: undefined, answer: undefined }), queueId: 'same-local-input' };
  const second = { ...submission('second-attempt', 1), queueId: first.queueId };
  const project = createDataProjection();
  project({ ...state, submission: first, submissions: tracked(first) });
  const data = project({ ...state, messages: [user, answer], submission: second, submissions: tracked(first, second) });
  assert.deepEqual(eligible(data), [], 'an already tracked local request does not become new merely because its POST identity changes');
  const fresh = createDataProjection();
  fresh(state);
  fresh({ ...state, submission: first, submissions: tracked(first) });
  assert.deepEqual(eligible(fresh({ ...state, messages: [user, answer], submission: second, submissions: tracked(first, second) })), [1]);
});
