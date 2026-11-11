import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactType } from '@weiliang0121/capix-changes';
import { TranscriptFacts } from '@weiliang0121/capix-transcript';
import { MemoryFacts } from '@weiliang0121/capix-memory';
import { MemoryRecord, TranscriptRecord, recordContentFact } from '@weiliang0121/capix-records';

const occurredAt = '2026-11-11T00:00:00.000Z';
const source = { contextId: 'context', callId: 'call-record', executionId: 'execution-record' };

function delivery(type, event, contextId = source.contextId) {
  return { contextId, offerId: 'offer', access: 'write', supplyId: 'supply', operationId: 'resource-operation', sequence: 2, occurredAt, fact: type.create(event) };
}

function transcriptEvent(change) {
  return { type: 'transcript', transcriptId: 'transcript', revision: 7, occurredAt, origin: { contextId: source.contextId }, change };
}

function memoryEvent(action) {
  return { type: 'memory', memoriesId: 'memories', sequence: 3, occurredAt, origin: { contextId: source.contextId }, change: { action, memoryId: 'memory', explanation: 'changed understanding', sourceIndexes: [2], sourceResults: [], result: { topic: 'topic', content: 'content', sourceIndexes: [2] } } };
}

test('content projection preserves transcript append and segment record semantics', () => {
  const records = [];
  const writer = { add: (record) => records.push(record) };
  const append = transcriptEvent({
    kind: 'messages-appended',
    start: 2,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply' },
    ],
  });
  const segment = transcriptEvent({ kind: 'segment-started', previousStart: 0, start: 2, end: 4 });
  recordContentFact(delivery(TranscriptFacts, append), source, writer);
  recordContentFact(delivery(TranscriptFacts, segment), source, writer);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.ok(record instanceof TranscriptRecord);
    assert.equal(record.transcriptId, 'transcript');
    assert.equal(record.revision, 7);
    assert.equal(record.occurredAt, occurredAt);
    assert.equal(record.parentId, source.callId);
    assert.equal(record.contextId, source.contextId);
    assert.equal(record.callId, source.callId);
    assert.equal(record.executionId, source.executionId);
  }
  assert.deepEqual(records[0].value, { action: 'append', start: 2, end: 4 });
  assert.deepEqual(records[1].value, { action: 'segment', previousStart: 0, start: 2, end: 4 });
});

test('content projection preserves memory content and uses only record hierarchy operation identity', () => {
  const records = [];
  const writer = { add: (record) => records.push(record) };
  const create = memoryEvent('create');
  const update = memoryEvent('update');
  recordContentFact(delivery(MemoryFacts, create), source, writer);
  recordContentFact(delivery(MemoryFacts, update), { ...source, operationId: 'operation-record' }, writer);
  for (const [index, record] of records.entries()) {
    assert.ok(record instanceof MemoryRecord);
    assert.equal(record.memoriesId, 'memories');
    assert.equal(record.memoryId, 'memory');
    assert.equal(record.sequence, 3);
    assert.equal(record.parentId, source.callId);
    assert.equal(record.contextId, source.contextId);
    assert.equal(record.executionId, source.executionId);
    assert.equal(record.operationId, index === 0 ? undefined : 'operation-record');
    assert.deepEqual(record.value, { action: index === 0 ? 'create' : 'update', change: 'changed understanding', sourceIndexes: [2], sourceResults: [], result: create.change.result });
  }
  assert.equal(records.length, 2);
});

test('content projection rejects mismatched origin or forwarding context before writing records', () => {
  const records = [];
  const writer = { add: (record) => records.push(record) };
  for (const [type, event] of [
    [TranscriptFacts, transcriptEvent({ kind: 'messages-appended', start: 0, messages: [] })],
    [MemoryFacts, memoryEvent('create')],
  ]) {
    assert.throws(() => recordContentFact(delivery(type, { ...event, origin: { contextId: 'other' } }), source, writer), /origin does not match record source/);
    const { origin, ...withoutOrigin } = event;
    assert.throws(() => recordContentFact(delivery(type, withoutOrigin), source, writer), /origin does not match record source/);
    assert.throws(() => recordContentFact(delivery(type, event, 'other'), source, writer), /forwarding context does not match record source/);
  }
  assert.deepEqual(records, []);
});

test('content projection ignores unknown type identities without interpreting their origin', () => {
  const records = [];
  const writer = { add: (record) => records.push(record) };
  for (const [type, event] of [
    [TranscriptFacts, transcriptEvent({ kind: 'messages-appended', start: 0, messages: [] })],
    [MemoryFacts, memoryEvent('create')],
  ]) {
    recordContentFact(delivery(new FactType(type.name), event), source, writer);
    recordContentFact(delivery(new FactType(type.name), { ...event, origin: { contextId: 'other' } }), source, writer);
  }
  recordContentFact(delivery(new FactType('business'), { value: 42 }), source, writer);
  assert.deepEqual(records, []);
});
