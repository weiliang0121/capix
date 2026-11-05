import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node } from '@capix/structure';
import { z } from 'zod';
import { acceptReply, acceptReplyStream, acceptFeedback, encodeHistory, validateReply } from '../examples/native-tools/protocol.mjs';
import { createCatalog, validateCatalog, precheck, tool } from '../examples/native-tools/catalog.mjs';
import { partitionBlocks, assembleBlocks } from '../examples/native-tools/blocks.mjs';
import { toolReply, finalReply, toolStream } from '../examples/native-tools/fixtures.mjs';

const entries = [{ name: 'read_text', description: 'Read one named file.', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, member: { position: 0, contract: 'fixture.read', version: 1 } }];
const textResult = (text, status = 'ok') => ({ status, content: [{ kind: 'text', text }] });

test('native tool JSON and byte-split SSE yield the same single reply representation', () => {
  const raw = toolReply([
    { id: 'call-a', name: 'read_text', arguments: '{"path":"诗.md"}' },
    { id: 'call-b', name: 'read_text', arguments: '{"path":"b.md"}' },
  ]);
  raw.usage.prompt_cache_hit_tokens = 12;
  raw.usage.prompt_cache_miss_tokens = 8;
  const reply = acceptReply(raw);
  assert.deepEqual(acceptReplyStream([...toolStream(raw)].map((byte) => Uint8Array.of(byte))), reply);
  assert.ok(Object.isFrozen(reply.output[1].arguments));
  raw.choices[0].message.tool_calls[0].function.arguments = 'changed';
  assert.equal(reply.output[1].arguments.text, '{"path":"诗.md"}');
  assert.equal(reply.native.reasoningContent, '需要读取原文。');
  assert.equal(reply.usage.promptCacheHitTokens, 12);
  const restored = validateReply(JSON.parse(JSON.stringify(reply)));
  const feedback = [acceptFeedback('call-b', textResult('not found', 'error')), acceptFeedback('call-a', textResult('poem'))];
  const history = encodeHistory(restored, feedback);
  assert.equal(history[0].tool_calls[0].function.arguments, reply.output[1].arguments.text);
  assert.deepEqual(
    history.slice(1).map((item) => item.tool_call_id),
    ['call-a', 'call-b'],
  );
  assert.equal(JSON.parse(history[2].content).status, 'error');
  assert.equal(history[0].reasoning_content, reply.native.reasoningContent);
});

test('native tool codec preserves final, pure tool and mixed content distinctly', () => {
  const final = acceptReply(finalReply('Done'));
  assert.deepEqual(final.output, [{ kind: 'text', text: 'Done' }]);
  assert.equal(final.native.version, 1);
  assert.equal(final.native.source, 'deepseek');
  assert.deepEqual(encodeHistory(final, []), [{ role: 'assistant', content: 'Done' }]);
  const pure = acceptReply(toolReply(undefined, { content: null }));
  assert.equal(pure.output.length, 1);
  assert.equal(pure.output[0].kind, 'tool-call');
  const invalidJson = acceptReply(toolReply([{ id: 'bad', name: 'read_text', arguments: '{broken' }]));
  assert.equal(invalidJson.output[1].arguments.text, '{broken');
});

test('native tool restore rejects competing native facts, changed versions and malformed feedback', () => {
  const reply = acceptReply(toolReply());
  assert.throws(() => validateReply({ ...reply, native: { ...reply.native, tool_calls: [] } }));
  assert.throws(() => validateReply({ ...reply, native: { ...reply.native, version: 2 } }));
  assert.throws(() => validateReply({ ...reply, termination: { kind: 'completed', reason: 'length' } }));
  assert.throws(() => validateReply({ ...reply, usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, promptCacheHitTokens: 3 } }));
  assert.throws(() => validateReply({ ...reply, usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, promptCacheHitTokens: 1, promptCacheMissTokens: 0 } }));
  assert.throws(() => encodeHistory(reply, []), /close/);
  assert.throws(() => encodeHistory(reply, [acceptFeedback('other', textResult('x'))]), /unknown/);
  assert.throws(() => acceptFeedback('call-read', { ...textResult('x'), toolCallId: 'other' }));
  assert.throws(() => encodeHistory(reply, [acceptFeedback('call-read', textResult('x')), acceptFeedback('call-read', textResult('x'))]));
  const incomplete = structuredClone(toolReply());
  incomplete.choices[0].finish_reason = 'length';
  assert.equal(acceptReply(incomplete).termination.kind, 'incomplete');
  assert.throws(() => encodeHistory(acceptReply(incomplete), [acceptFeedback('call-read', textResult('x'))]), /cannot continue/);
});

test('native tool input acceptance rejects duplicate IDs, unsupported fields and hostile values', () => {
  assert.throws(
    () =>
      acceptReply(
        toolReply([
          { id: 'same', name: 'read_text', arguments: '{}' },
          { id: 'same', name: 'read_text', arguments: '{}' },
        ]),
      ),
    /Duplicate/,
  );
  const unknown = toolReply();
  unknown.choices[0].message.server_tool = {};
  assert.throws(() => acceptReply(unknown));
  const getter = {
    get id() {
      throw new Error('getter executed');
    },
  };
  assert.throws(() => acceptReply(getter), /accessors/);
  assert.throws(() => acceptReply(finalReply('x'.repeat(2 * 1024 * 1024))), /byte limit/);
  assert.throws(() => acceptReply({ ...finalReply(), model: undefined }));
});

test('native tool call limits agree for received, streamed and restored replies', () => {
  const calls = Array.from({ length: 32 }, (_, index) => ({ id: `call-${index}`, name: 'read_text', arguments: '{}' }));
  const raw = toolReply(calls, { content: null });
  const reply = acceptReply(raw);
  assert.equal(validateReply(reply).output.length, 32);
  assert.deepEqual(acceptReplyStream([toolStream(raw)]), reply);
  assert.throws(() => acceptReply(toolReply([...calls, { ...calls[0], id: 'call-32' }], { content: null })));
  assert.throws(() => validateReply({ ...reply, output: [...reply.output, { ...reply.output[0], id: 'call-32' }] }), { name: 'TypeError', message: 'Reply exceeds tool call limit' });
});

test('native tool SSE refuses truncated, inconsistent, post-terminal and invalid streams', () => {
  const stream = toolStream(toolReply()).toString();
  assert.throws(() => acceptReplyStream([stream.replace('data: [DONE]\n\n', '')]), /incomplete/);
  assert.throws(() => acceptReplyStream([stream.replace('"finish_reason":"tool_calls"', '"finish_reason":null')]), /finish reason/);
  assert.throws(() => acceptReplyStream([stream.replace('data: [DONE]\n\n', '') + 'data: {"id":"other","model":"offline-deepseek","choices":[]}\n\ndata: [DONE]\n\n']), /identity/);
  assert.throws(() => acceptReplyStream([stream + 'data: {}\n\n']), /framing/);
  assert.throws(() => acceptReplyStream([Uint8Array.from([255])]), /encoded data/);
  assert.throws(() => acceptReplyStream([stream.slice(0, -1)]), /event/);
});

test('native tool SSE rejects precise terminal, usage and tool identity violations', () => {
  const chunk = (choices, usage) => ({ id: 'reply', model: 'offline-deepseek', choices, ...(usage ? { usage } : {}) });
  const choice = (delta, finish_reason = null) => [{ index: 0, delta, finish_reason }];
  const call = (index, id) => ({ index, id, type: 'function', function: { name: 'read_text', arguments: '{}' } });
  const terminal = chunk(choice({}, 'tool_calls'));
  const initial = chunk(choice({ tool_calls: [call(0, 'call-a')] }));
  const reported = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
  const stream = (...events) => [events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'];
  assert.throws(() => acceptReplyStream(stream(initial, terminal, chunk(choice({ content: 'late' })))), { name: 'TypeError', message: 'Tool stream continued after termination' });
  assert.throws(() => acceptReplyStream(stream(initial, terminal, chunk([], reported), chunk([], reported))), { name: 'TypeError', message: 'Duplicate tool stream usage' });
  assert.throws(() => acceptReplyStream(stream(chunk(choice({ tool_calls: [call(0, 'same'), call(1, 'same')] })), terminal)), { name: 'TypeError', message: 'Duplicate tool call identity' });
  assert.throws(() => acceptReplyStream(stream(initial, chunk(choice({ tool_calls: [{ index: 0, id: 'call-a' }] })), terminal)), { name: 'TypeError', message: 'Duplicate streamed tool ID' });
  assert.throws(() => acceptReplyStream(stream(chunk(choice({ tool_calls: [call(0, 'call-a'), call(2, 'call-c')] })), terminal)), { name: 'TypeError', message: 'Tool stream call indexes have gaps' });
});

test('native catalog digest is stable for object key construction but preserves array and policy changes', () => {
  const catalog = createCatalog(entries, { policyVersion: 'tool-loop.v1' });
  const equivalent = JSON.parse(JSON.stringify(entries));
  equivalent[0].schema = { additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } }, type: 'object' };
  assert.equal(createCatalog(equivalent, { policyVersion: 'tool-loop.v1' }).digest, catalog.digest);
  assert.equal(validateCatalog(catalog, JSON.parse(JSON.stringify(catalog))).digest, catalog.digest);
  for (const change of [
    (entry) => {
      entry.description = 'Changed';
    },
    (entry) => {
      entry.name = 'read_other';
    },
    (entry) => {
      entry.member.position = 1;
    },
    (entry) => {
      entry.member.version = 2;
    },
    (entry) => {
      entry.schema.properties.path.type = 'integer';
    },
  ]) {
    const changed = structuredClone(entries);
    change(changed[0]);
    assert.throws(() => validateCatalog(catalog, createCatalog(changed, { policyVersion: 'tool-loop.v1' })), /changed/);
  }
  assert.throws(() => validateCatalog(catalog, createCatalog(entries, { policyVersion: 'tool-loop.v2' })), /changed/);
  assert.throws(() => createCatalog([{ ...entries[0], schema: { ...entries[0].schema, patternProperties: {} } }]));
  const twoFields = structuredClone(entries);
  twoFields[0].schema.properties.other = { type: 'string' };
  twoFields[0].schema.required.push('other');
  const first = createCatalog(twoFields);
  twoFields[0].schema.required.reverse();
  assert.notEqual(createCatalog(twoFields).digest, first.digest);
});

test('native tool prechecks return versioned error feedback without invoking children', () => {
  const catalog = createCatalog(entries);
  const call = (name, argumentsText) => ({ kind: 'tool-call', id: 'slot', name, arguments: { encoding: 'json-text', text: argumentsText } });
  assert.deepEqual(precheck(catalog, call('read_text', '{"path":"a.md"}')), { kind: 'accepted', name: 'read_text', input: { path: 'a.md' } });
  for (const item of [call('unknown', '{}'), call('read_text', '{broken'), call('read_text', '{"path":3}'), call('read_text', '{"path":"a","other":"b"}')]) {
    const rejected = precheck(catalog, item);
    assert.equal(rejected.kind, 'rejected');
    assert.equal(rejected.feedback.toolCallId, 'slot');
    assert.equal(rejected.feedback.status, 'error');
    assert.ok(JSON.parse(rejected.feedback.content[0].text).code);
  }
  assert.equal(catalog.snapshot.precheckVersion, 1);
});

test('native ordered-block counterexample stores each content once and rejects layout ambiguity', () => {
  const original = [
    { type: 'thinking', thinking: 'Plan', signature: 'opaque-signature' },
    { type: 'text', text: 'Before' },
    { type: 'tool_use', id: 'a', name: 'read_text', input: { path: 'a.md' } },
    { type: 'text', text: 'After' },
  ];
  const partition = partitionBlocks(original);
  assert.deepEqual(assembleBlocks(JSON.parse(JSON.stringify(partition))), original);
  assert.deepEqual(
    partition.output.map((item) => item.kind),
    ['text', 'tool-call', 'text'],
  );
  assert.equal(partition.native.blocks.length, 1);
  for (const change of [
    (value) => value.native.layout.push({ kind: 'output', index: 0 }),
    (value) => value.native.layout.pop(),
    (value) => {
      [value.native.layout[1], value.native.layout[3]] = [value.native.layout[3], value.native.layout[1]];
    },
    (value) => {
      value.native.layout[0].index = 100;
    },
  ]) {
    const changed = structuredClone(partition);
    change(changed);
    assert.throws(() => assembleBlocks(changed), /reference|omitted/);
  }
  assert.throws(() => assembleBlocks({ ...partition, native: { ...partition.native, tool_calls: [] } }));
});

test('native tool configuration fixes its member and reception function references', () => {
  const node = new Node({ run: () => 'value' });
  const succeeded = (value) => textResult(value);
  const result = { succeeded };
  const configured = tool(node, { description: 'Read', input: z.string(), result });
  result.succeeded = () => textResult('changed');
  assert.equal(configured.result.succeeded, succeeded);
  assert.equal(configured.node, node);
  assert.throws(() => tool(node, { node: new Node(), description: 'Read', input: z.string(), result }), /Unsupported/);
});
