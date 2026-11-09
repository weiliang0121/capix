import { contextWithSource, sourceFor } from '../fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript } from '@weiliang0121/capix-transcript';
import { Memory } from '@weiliang0121/capix-memory';

import { initializeObserver, acceptConversationInput, observeExecution, memoryOutputContract } from '@capix/observer-service';

const settings = { model: 'test', contextBudget: 16000, maxOutputTokens: 1536, timeoutMs: 1000 };
const reply = (value) => ({ id: 'fixture', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('segments preserve absolute identities and previously captured ranges', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'response' },
  ]);
  const old = contextWithSource(transcript.get(0), { settings, transcript });
  const ref = transcript.ref(0);
  transcript.append({ role: 'user', content: 'new' });
  transcript.startSegment(2);
  const next = contextWithSource(transcript.get(2), { settings, transcript });
  assert.deepEqual(
    transcript.segments().map(({ start, end }) => [start, end]),
    [
      [0, 2],
      [2, 3],
    ],
  );
  assert.equal(sourceFor(old).transcriptRange.start, 0);
  assert.equal(sourceFor(old).transcriptRange.end, 2);
  assert.equal(ref.read(), transcript.get(0));
  assert.equal(sourceFor(next).transcriptRange.start, 2);
  assert.throws(() => sourceFor(next).transcriptRange.read(0), RangeError);
  assert.throws(() => transcript.startSegment(2), RangeError);
  transcript.append({ role: 'assistant', content: 'new response' });
  assert.equal(sourceFor(next).transcriptRange.end, 3);
  assert.equal(transcript.segments()[1].end, 4);
});

test('default active material does not segment or truncate history to satisfy capacity', async () => {
  let requests = 0;
  const environment = initializeObserver({
    invoke: async () => {
      requests++;
      assert.fail('oversized material must fail before provider dispatch');
    },
  });
  environment.transcript.append({ role: 'user', content: '培训周五15点。' + '原始说明。'.repeat(6000) }, { role: 'assistant', content: '收到。' });
  const original = environment.transcript.ref(0);
  const memory = environment.memories.apply([{ action: 'create', memoryId: null, change: '接纳初始记忆', sourceIndexes: [0], result: { topic: '培训', content: '培训周五15点。', sourceIndexes: [0] } }])[0];
  const facts = await observeExecution(environment.runner, environment.records.installation, { messages: [{ role: 'user', content: '培训几点？' }] }, { settings });
  assert.equal(facts.execution.status, 'failed');
  assert.match(JSON.stringify(facts.execution.value.error), /CAPACITY_EXCEEDED/);
  assert.equal(facts.resources.find((fact) => fact.parentId === facts.execution.id && fact.access === 'transcript.fixedRange' && fact.phase === 'available').value.start, 0);
  assert.equal(environment.transcript.activeStart, 0);
  assert.equal(environment.transcript.length, 3, 'accepted input remains a formal message');
  assert.equal(original.read(), environment.transcript.get(0));
  assert.deepEqual(memory.sourceIndexes, [0]);
  assert.equal(requests, 0);
  const material = environment.content.active.capture();
  assert.deepEqual(
    material.messages.map(({ index }) => index),
    [0, 1, 2],
  );
  assert.deepEqual(
    material.memories.map(({ id }) => id),
    [memory.id],
  );
});

test('only an update target may retain its own archived sources; fresh evidence stays in the active input', () => {
  const input = {
    currentIndexes: [4, 5],
    messages: [{ index: 4, message: { role: 'user', content: '改为16点' } }],
    memories: [
      { id: 'a', topic: '培训', content: '15点', sourceIndexes: [0] },
      { id: 'b', topic: '聚餐', content: '18点', sourceIndexes: [2] },
    ],
  };
  const change = { action: 'update', memoryId: 'a', change: '改为16点', sourceIndexes: [4], result: { topic: '培训', content: '16点', sourceIndexes: [0, 4] } };
  assert.equal(memoryOutputContract.accept({ memories: [change] }, input).memories.length, 1);
  for (const invalid of [
    { ...change, sourceIndexes: [0, 4] },
    { ...change, result: { ...change.result, sourceIndexes: [2, 4] } },
    { ...change, action: 'create', memoryId: null },
  ])
    assert.throws(
      () => memoryOutputContract.accept({ memories: [invalid] }, input),
      (error) => error.code === 'MEMORY_SOURCE',
    );
});

test('explicitly filtering active membership preserves original messages and transcript segments', async () => {
  const requests = [];
  const environment = initializeObserver({
    async invoke(request, purpose) {
      requests.push({ purpose, input: JSON.parse(request.messages[1].content) });
      return reply(purpose === 'answer' ? { kind: 'answer', content: '继续。' } : { memories: [] });
    },
  });
  environment.transcript.append({ role: 'user', content: 'large context '.repeat(5000) }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'recent input' }, { role: 'assistant', content: 'recent output' });
  const originals = environment.transcript.snapshot();
  const before = environment.content.active.capture();
  environment.content.active.apply({ basis: before.basis, messageIndexes: [2, 3], memoryIds: [] });
  const facts = await observeExecution(environment.runner, environment.records.installation, { messages: [{ role: 'user', content: '继续刚才那个' }] }, { settings });
  assert.equal(facts.execution.status, 'succeeded', JSON.stringify(facts.execution.value.error));
  assert.deepEqual(
    requests.map(({ purpose }) => purpose),
    ['answer', 'memory'],
  );
  assert.deepEqual(
    requests[0].input.history.map(({ index }) => index),
    [2, 3],
  );
  assert.equal(environment.transcript.activeStart, 0);
  assert.deepEqual(
    environment.transcript.segments().map(({ start, end }) => [start, end]),
    [[0, 6]],
  );
  for (const [index, message] of originals.entries()) assert.equal(environment.transcript.get(index), message);
});

test('retention stops at incomplete messages and never pulls a pair back out of an archived segment', async () => {
  const { segmentCandidates } = await import('@capix/observer-service');
  const { TranscriptRangeRef, TranscriptRangeReader } = await import('@weiliang0121/capix-transcript');
  const transcript = new Transcript([
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old response' },
    { role: 'user', content: 'unanswered' },
    { role: 'user', content: 'recent' },
    { role: 'assistant', content: 'response' },
    { role: 'user', content: 'current' },
  ]);
  const range = new TranscriptRangeRef(transcript, 0, 6);
  assert.deepEqual(
    segmentCandidates(new TranscriptRangeReader(range)).map((candidate) => candidate.start),
    [3, 5],
  );
  transcript.startSegment(4);
  assert.deepEqual(
    segmentCandidates(new TranscriptRangeReader(new TranscriptRangeRef(transcript, 4, 6))).map((candidate) => candidate.start),
    [5],
  );
});
