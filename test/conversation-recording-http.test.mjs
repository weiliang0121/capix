import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationWebHost } from '@capix/conversation-service/web';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { SessionHttpTransport } from '@capix/client-http';

test('recording controls select subsequent Scene calls, drain the selected tree and leave content and CP independent', { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-recording-http-'));
  const database = join(directory, 'conversation.sqlite');
  const entered = [Promise.withResolvers(), Promise.withResolvers()];
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let answers = 0;
  const host = createConversationWebHost({
    database,
    mode: 'demo',
    modelName: 'fixture',
    model: {
      async complete(request) {
        if (request.responseFormat !== 'json_object') {
          const position = answers++;
          entered[position]?.resolve();
          await gates[position]?.promise;
        }
        return { id: 'fixture', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: request.responseFormat === 'json_object' ? '{"changes":[]}' : 'answer' }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
      },
    },
  });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const transport = new SessionHttpTransport(origin, (url, options) => fetch(url, { ...options, headers: { ...options?.headers, Origin: origin } }));
  const info = await transport.session();
  const post = (path, body = {}) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const submit = async (id) => {
    const frames = [];
    await transport.submit({ conversationId: info.conversationId, submissionId: id, input: { messages: [{ role: 'user', content: id }] } }, (frame) => frames.push(frame), new AbortController().signal);
    assert.ok(frames.some((frame) => (frame.submission ?? frame.change)?.result?.status === 'completed'));
  };

  assert.deepEqual(await transport.recording(), { status: 'idle' });
  assert.deepEqual((await transport.inspection()).recording, { status: 'idle', revision: 0, integrity: 'intact', calls: [], omitted: 0 });
  const unrecorded = submit('before-start');
  await entered[0].promise;
  const first = await transport.startRecording();
  assert.equal(first.status, 'recording');
  assert.deepEqual(await transport.startRecording(), first, 'repeated start cannot replace this capture');
  assert.equal((await transport.inspection()).recording.calls.length, 0, 'starting mid-call does not fabricate its beginning');
  gates[0].resolve();
  await unrecorded;
  assert.equal((await transport.inspection()).recording.calls.length, 0, 'later children of an unselected root remain outside capture');
  assert.equal((await transport.stopRecording(first.recorderId)).status, 'stopped');
  assert.equal((await post('/api/recording/start')).status, 409, 'a retained capture is not silently replaced');
  assert.deepEqual(await transport.clearRecording(first.recorderId), { status: 'idle' });

  const second = await transport.startRecording();
  assert.notEqual(second.recorderId, first.recorderId);
  const recorded = submit('selected');
  await entered[1].promise;
  const stopped = await transport.stopRecording(second.recorderId);
  assert.equal(stopped.status, 'stopping');
  assert.equal((await post('/api/recording/start')).status, 409);
  assert.equal((await post('/api/recording/clear', { recorderId: second.recorderId })).status, 409);
  assert.equal((await transport.inspection()).recording.calls[0].status, 'running');
  gates[1].resolve();
  await recorded;
  assert.deepEqual(await transport.recording(), { status: 'stopped', recorderId: second.recorderId });
  const captured = (await transport.inspection()).recording;
  assert.equal(captured.integrity, 'intact');
  assert.equal(captured.calls.length, 1);
  assert.equal(captured.calls[0].status, 'succeeded');
  const detail = await transport.call(captured.calls[0].id);
  assert.equal(detail.transcripts.length, 2);
  assert.ok(detail.calls.length > 0, 'selected descendants keep real records through stop');
  assert.ok(detail.calls.every((call) => call.status !== 'running'));
  await submit('after-stop');
  assert.deepEqual((await transport.inspection()).recording, captured, 'later normal calls do not extend a stopped capture');
  const content = await transport.transcript(info.transcriptId);
  const beforeClear = await transport.inspection();
  assert.deepEqual(await transport.clearRecording(second.recorderId), { status: 'idle' });
  assert.deepEqual(await transport.transcript(info.transcriptId), content);
  const cleared = await transport.inspection();
  assert.deepEqual(cleared.memories, beforeClear.memories);
  assert.deepEqual(cleared.view, beforeClear.view);
  assert.equal((await fetch(origin + `/api/calls/${captured.calls[0].id}`)).status, 404);

  const third = await transport.startRecording();
  for (const action of ['stop', 'clear']) {
    const stale = await post(`/api/recording/${action}`, { recorderId: second.recorderId });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'RECORDING_CONFLICT');
  }
  assert.deepEqual(await transport.recording(), third, 'stale controls cannot stop or clear a newer capture');
  assert.equal((await post('/api/recording/stop')).status, 400);
  assert.equal((await post('/api/recording/start', { extra: true })).status, 400);
  const crossOrigin = await fetch(origin + '/api/recording/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://elsewhere.test' }, body: JSON.stringify({ recorderId: third.recorderId }) });
  assert.equal(crossOrigin.status, 403);
  await transport.stopRecording(third.recorderId);
  await transport.clearRecording(third.recorderId);
  await host.close();
  const store = ConversationStore.open(database);
  try {
    assert.equal(store.load().transcript.messages.length, 6);
    assert.equal(store.checkpoints.listRoots().length, 3, 'recording start, stop and clear do not remove persisted checkpoint roots');
  } finally {
    store.close();
  }
});
