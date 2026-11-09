import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resource } from '@weiliang0121/capix-resources';
import { Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';
import { View } from '@weiliang0121/capix-view';
import { createHistoryTools, HistoryToolResource, createToolPreparation, ToolPreparationResource } from '@capix/conversation-service/tools/hosting';
import { resolveToolConversationPolicy, createToolConversationParts } from '@capix/conversation-service/assembly';
import { assertToolFeedbackBytes } from '@capix/conversation-service/tools';

class Journal extends MemoryCheckpointStore {
  images = [];
  save(image, revision) {
    const value = super.save(image, revision);
    this.images.push(image);
    return value;
  }
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function fixture(messages, settings) {
  const transcript = new Transcript([...messages, { role: 'user', content: 'current query' }]);
  const query = { transcriptId: transcript.id, index: messages.length, content: 'current query' };
  const policy = resolveToolConversationPolicy(settings);
  return { transcript, query, policy };
}
function assemble(source, name) {
  const registration = createHistoryTools(source.policy)[name];
  const checkpoints = new Journal();
  const runner = new Runner(new Scene(registration.node), new Resources().register(new Resource(source), HistoryToolResource), undefined, { checkpoints: { store: checkpoints } }).build();
  return { runner, registration, checkpoints };
}

test('history tools use the fixed prefix and original absolute indexes, never current/later messages', async () => {
  const source = fixture([
    { role: 'user', content: '项目 alpha' },
    { role: 'assistant', content: '周三验收 alpha' },
    { role: 'user', content: '另一个项目' },
  ]);
  const search = assemble(source, 'search_history');
  const first = await search.runner.run({ query: 'alpha', limit: 1 });
  assert.equal(first.matches[0].index, 0);
  assert.equal(first.matches[0].offset, 3);
  assert.equal(first.nextIndex, 1);
  const second = await search.runner.run({ query: 'alpha', fromIndex: first.nextIndex });
  assert.equal(second.matches[0].index, 1);
  assert.equal(second.nextIndex, null);
  source.transcript.append({ role: 'assistant', content: 'later alpha' });
  const later = await search.runner.run({ query: 'alpha' });
  assert.deepEqual(
    later.matches.map((item) => item.index),
    [0, 1],
  );
  assert.equal(later.before, 3);
  const read = assemble(source, 'read_message');
  assert.equal((await read.runner.run({ index: 1, offset: 2, length: 4 })).text, '验收 a');
  await assert.rejects(read.runner.run({ index: 3 }), /outside the history/);
  await assert.rejects(read.runner.run({ index: 4 }), /outside the history/);
});

test('bounded search returns an exact scan cursor even when a page has no match', async () => {
  const source = fixture(
    Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: index === 4 ? 'needle' : 'other' })),
    { history: { maxSearchMessages: 2 } },
  );
  const h = assemble(source, 'search_history');
  const first = await h.runner.run({ query: 'needle' });
  assert.deepEqual(first.matches, []);
  assert.equal(first.scanned, 2);
  assert.equal(first.nextIndex, 2);
  const last = await h.runner.run({ query: 'needle', fromIndex: 4 });
  assert.equal(last.matches[0].index, 4);
  assert.equal(last.nextIndex, null);
});

test('historical fragments preserve UTF-16 offsets and fit raw CP plus worst-ID feedback encoding', async () => {
  const original = '😀\u0000"\\汉'.repeat(400);
  const source = fixture([{ role: 'assistant', content: original }]);
  const h = assemble(source, 'read_message');
  let offset = 0;
  let combined = '';
  while (offset < original.length) {
    const output = await h.runner.run({ index: 0, offset, length: 1024 });
    assert.equal(output.text, original.slice(offset, offset + output.text.length));
    assert.ok(bytes(output) <= source.policy.history.maxOutputBytes);
    const feedback = h.registration.result.succeeded(output);
    assertToolFeedbackBytes('\u0000'.repeat(256), feedback, source.policy.budgets);
    combined += output.text;
    if (output.nextOffset === null) break;
    assert.ok(output.nextOffset > offset);
    offset = output.nextOffset;
  }
  assert.equal(combined, original);
  await assert.rejects(h.runner.run({ index: 0, offset: 1 }), /UTF-16/);
  assert.ok(h.checkpoints.images.every((image) => bytes(image.state) <= source.policy.history.maxOutputBytes));
});

test('source mismatch fails before reading and legitimate bad indexes remain explicit tool feedback', async () => {
  const source = fixture([{ role: 'user', content: 'old' }]);
  const h = assemble(source, 'read_message');
  const failure = await h.runner.run({ index: 99 }).then(
    () => undefined,
    (error) => error,
  );
  assert.equal(h.registration.result.failed(failure).status, 'error');
  source.query = { ...source.query, content: 'changed' };
  await assert.rejects(h.runner.run({ index: 0 }), /exact accepted query/);
});

test('history feedback strings remain exact after CP Schema decoding changes object field order', async () => {
  const source = fixture([{ role: 'user', content: 'previous alpha' }]);
  for (const [name, input] of [
    ['read_message', { index: 0 }],
    ['search_history', { query: 'alpha' }],
  ]) {
    const h = assemble(source, name);
    const value = await h.runner.run(input);
    const decoded = h.registration.node.checkpoint.output.decode(h.registration.node.checkpoint.output.encode(value));
    assert.deepEqual(h.registration.result.succeeded(value), h.registration.result.succeeded(decoded));
  }
});

test('tool preparation keeps active memories but does not read historical message bodies', async () => {
  const transcript = new Transcript([
    { role: 'user', content: 'historical secret'.repeat(500) },
    { role: 'user', content: 'query' },
  ]);
  const memories = new Memories(transcript);
  const [memory] = memories.apply([{ action: 'create', memoryId: null, change: 'preference', sourceIndexes: [0], result: { topic: 'preference', content: 'brief', sourceIndexes: [0] } }]);
  const view = new View({
    revision: 0,
    sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } },
    members: [
      { source: 'messages', key: 0 },
      { source: 'memories', key: memory.id },
    ],
  });
  const source = { transcript, memories, view };
  const get = transcript.get.bind(transcript);
  transcript.get = (index) => {
    const value = get(index);
    if (index !== 0) return value;
    return new Proxy(value, {
      get(target, key, receiver) {
        if (key === 'content') throw new Error('Preparation must not inspect old message bodies');
        return Reflect.get(target, key, receiver);
      },
    });
  };
  const prepare = createToolPreparation(256 * 1024);
  const runner = new Runner(new Scene(prepare), new Resources().register(new Resource(source), ToolPreparationResource)).build();
  const input = { transcriptId: transcript.id, index: 1, message: transcript.get(1) };
  const output = await runner.run(input);
  assert.deepEqual(
    output.materials.entries.map((entry) => entry.source),
    ['memories'],
  );
  assert.equal(JSON.stringify(output).includes('historical secret'), false);
  assert.equal(output.query.index, 1);
  assert.equal(output.materials.entries[0].value.id, memory.id);
  assert.equal(output.materials.basis.sources.messages.id, transcript.id);
  assert.deepEqual(output.materials.basis.sources, view.indexSync({ messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) }).basis.sources);
  const baseline = createToolConversationParts(source);
  const changed = createToolConversationParts(source, {}, { history: { maxSearchMessages: 100 } });
  assert.notEqual(baseline.loop.catalog.digest, changed.loop.catalog.digest);
  assert.deepEqual(
    baseline.loop.stages.tools.map((tool) => tool.name),
    ['search_history', 'read_message'],
  );
});
