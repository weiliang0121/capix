import { Driver } from '@capix/server-runtime';
import { ActiveContent } from '@capix/observer-service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ConversationSubmission, bindConversation, createConversationStructure, ModelInteractions, ModelSource } from '@capix/observer-service';
import { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import { ClientSubmission } from '@capix/client-runtime';

const tick = () => new Promise((resolve) => queueMicrotask(resolve));
const occurredAt = '2026-10-01T00:00:00.000Z';
const fact = (contextId, structureKind, kind, eventSequence, fields = {}) => ({ identity: { contextId, kind: structureKind, ...(structureKind === 'group' ? { parentContextId: 'r' } : {}) }, kind, eventSequence, occurredAt, ...fields });
const event = (submission, kind, sequence, fields = {}) => submission.answerProgress.publish({ kind: 'generation', event: { kind, sequence, contextId: 'answer', round: 1, ...fields } });
const size = (frame) => Buffer.byteLength(JSON.stringify(frame) + '\n');

test('preview chunks neither resend nor rebuild cumulative call state, regardless of graph size', async () => {
  async function measure(count) {
    const submission = new ConversationSubmission('submission', 'conversation');
    submission.activity.publish(fact('r', 'scene', 'started', 1));
    for (let index = 0; index < count; index++) submission.activity.publish(fact(`e-${index}`, 'group', 'started', 1));
    await tick();
    const snapshot = submission.snapshot;
    const frames = [];
    const detach = submission.connectFrames((frame) => {
      frames.push(frame);
    });
    const notifications = [];
    const stop = submission.connect((value) => {
      notifications.push(value);
    });
    event(submission, 'started', 1);
    await tick();
    for (let index = 0; index < 100; index++) {
      event(submission, 'delta', index + 2, { delta: { text: '模拟正文。' } });
      await tick();
    }
    detach();
    stop();
    assert.strictEqual(submission.snapshot, snapshot, 'preview-only publication does not recreate call snapshots');
    assert.equal(notifications.length, 1, 'local cumulative-state consumers are not notified for unrelated preview data');
    assert.equal(frames.filter((frame) => frame.type === 'baseline').length, 1);
    assert.equal(frames.filter((frame) => frame.type === 'submission').length, 0);
    assert.equal(frames.filter((frame) => frame.type === 'answer').length, 101);
    return frames.slice(1).reduce((bytes, frame) => bytes + size(frame), 0);
  }
  assert.equal(await measure(1), await measure(500), 'text transmission size must not depend on accumulated activity size');
});

test('activity changes contain only affected calls and unchanged boundary actions do not publish', async () => {
  const submission = new ConversationSubmission('submission', 'conversation');
  submission.activity.publish(fact('r', 'scene', 'started', 1));
  for (let index = 0; index < 100; index++) submission.activity.publish(fact(`e-${index}`, 'group', 'started', 1));
  await tick();
  const frames = [];
  submission.connectFrames((frame) => {
    frames.push(frame);
  });
  submission.activity.publish(fact('e-50', 'group', 'process', 2, { stage: 'execute', round: 1, action: 'start' }));
  await tick();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].type, 'submission');
  assert.deepEqual(
    frames[1].change.activities.calls.map((call) => call.contextId),
    ['e-50'],
  );
  const snapshot = submission.snapshot;
  submission.activity.publish(fact('e-50', 'group', 'process', 3, { stage: 'execute', round: 1, action: 'return' }));
  await tick();
  assert.equal(frames.length, 2, 'boundary facts already represented by the same phase are not retransmitted');
  assert.strictEqual(submission.snapshot, snapshot);
});

test('a connection established during pending changes starts at its current baseline without redundant updates', async () => {
  const submission = new ConversationSubmission('submission', 'conversation');
  submission.progress.publish({ kind: 'input', range: { transcriptId: 'transcript', start: 0, end: 1 } });
  const frames = [];
  submission.connectFrames((frame) => {
    frames.push(frame);
  });
  await tick();
  assert.equal(frames.length, 1);
  submission.progress.publish({ kind: 'execution', contextId: 'e' });
  await tick();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].fromRevision, frames[0].submission.revision);
  assert.deepEqual(frames[1].change.executions, [{ contextId: 'e' }]);
  assert.equal(frames[1].change.input, undefined);
});

test('full declared streaming chain stays within a wire budget and client reconstruction equals the final baseline', async (t) => {
  const content = '这是用于测量的模拟正文。'.repeat(100);
  const answer = { kind: 'answer', content };
  const raw = JSON.stringify(answer);
  const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
  const interactions = new ModelInteractions(
    new ModelSource({
      invoke: async (_request, purpose, _signal, progress) => {
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'memory') return output({ memories: [] });
        if (purpose === 'understanding') return output({ kind: 'reply' });
        for (let offset = 0; offset < raw.length; offset += 6) {
          progress.publish({ text: raw.slice(offset, offset + 6) });
          await setImmediate();
        }
        return output(answer);
      },
    }),
  );
  t.after(() => interactions.close());
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  const driver = new Driver();
  const scene = bindConversation(driver, createConversationStructure(), { transcript, memories, active: new ActiveContent(transcript, memories), selectionUsage: new SelectionUsage() }, interactions);
  const client = new ClientSubmission('volume-conversation', { messages: [{ role: 'user', content: '模拟问题' }] });
  const submission = new ConversationSubmission(client.id, client.conversationId, { admission: () => ({ conversationId: client.conversationId, transcriptId: transcript.id, status: driver.isRunning(scene) ? 'busy' : 'ready' }) });
  const frames = [];
  const detach = submission.connectFrames((frame) => {
    frames.push(frame);
    client.receiveFrame(frame);
  });
  const completed = new Promise((resolve) => {
    const close = submission.connect((snapshot) => {
      if (snapshot.result) {
        close();
        resolve(snapshot);
      }
    });
  });
  submission.start((signal) => driver.run(scene, client.input, { settings: { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 10000 }, signal, progress: submission.progress, activity: submission.activity, answerProgress: submission.answerProgress }));
  const final = await completed;
  await tick();
  detach();
  await interactions.settled();
  assert.equal(final.result.status, 'completed');
  assert.deepEqual(client.snapshot.remote, final);
  assert.deepEqual(client.snapshot.preview.snapshot, submission.baseline.preview);
  const bytes = frames.reduce((total, frame) => total + size(frame), 0);
  const stateFrames = frames.filter((frame) => frame.type === 'submission');
  assert.ok(bytes < 130_000, `wire budget exceeded: ${bytes} bytes for ${Buffer.byteLength(content)} bytes of text`);
  assert.equal(new Set(stateFrames.map((frame) => frame.revision)).size, stateFrames.length);
  assert.ok(stateFrames.every((frame) => !Object.hasOwn(frame, 'submission')));
  t.diagnostic(JSON.stringify({ answerBytes: Buffer.byteLength(content), frames: frames.length, bytes, submissionFrames: stateFrames.length, submissionBytes: stateFrames.reduce((total, frame) => total + size(frame), 0) }));
});
