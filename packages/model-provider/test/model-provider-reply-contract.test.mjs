import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertModelContinuation, assertModelRequestNodeCapacity, modelReplyText, readModelToolArguments, requireModelExchange, requireModelReply } from '@weiliang0121/capix-model-provider';

const visible = (index) => ({ kind: 'output', index });
const text = (text) => ({ kind: 'text', text });
const call = { kind: 'tool-call', id: 'a', name: 'lookup', arguments: { encoding: 'json-value', value: { city: '上海' } } };
const native = { format: 'anthropic-messages', version: 1, bindingId: 'deployment', model: 'alias', anthropicVersion: '2023-06-01', blocks: [{ kind: 'thinking', thinking: '', signature: 'sig' }, visible(0), visible(1), visible(2)] };
const signed = { ...native, prefixSha256: 'a'.repeat(64) };
const reply = { formatVersion: 1, id: 'message', model: 'resolved-model', output: [text('before'), call, text('after')], termination: { kind: 'completed', reason: 'tool_use' }, usage: null, native: signed };

test('offline validation enforces a bijection between the native layout and ordered public output', () => {
  assert.equal(requireModelReply(reply), reply);
  const corrupt = [
    [visible(0), visible(1)],
    [visible(0), visible(1), visible(2), visible(3)],
    [visible(0), visible(1), visible(1)],
    [visible(1), visible(0), visible(2)],
    [visible(0), visible(1), { ...visible(2), text: 'duplicate' }],
    [visible(0), visible(1), { kind: 'tool_use', id: 'a', input: {} }],
    [{ kind: 'thinking', thinking: 'private', signature: '' }, ...native.blocks],
    [{ kind: 'redacted_thinking', data: '' }, ...native.blocks],
  ];
  for (const blocks of corrupt) assert.throws(() => requireModelReply({ ...reply, native: { ...signed, blocks } }), TypeError);
  for (const change of [{ bindingId: ' ' }, { model: '' }, { anthropicVersion: 'unknown' }, { format: 'messages' }, { version: 2 }, { reasoningContent: 'duplicate' }]) assert.throws(() => requireModelReply({ ...reply, native: { ...signed, ...change } }), TypeError);
  for (const change of [{ termination: { kind: 'completed', reason: 'end_turn' } }, { output: [call, call, text('after')] }, { output: [text('no calls'), text(''), text('')] }, { output: [text('before'), { ...call, arguments: { encoding: 'json-text', text: '{}' } }, text('after')] }, { output: [text('before'), { ...call, arguments: { encoding: 'json-value', value: [] } }, text('after')] }, { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 4 } }, { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, promptCacheMissTokens: 1 } }]) assert.throws(() => requireModelReply({ ...reply, ...change }), TypeError);
  assert.throws(() => requireModelReply({ ...reply, native }), TypeError);
  assert.throws(() => requireModelReply({ ...reply, native: { ...signed, prefixSha256: 'invalid' } }), TypeError);
  const textOnly = { ...reply, output: [text('first'), text('second')], termination: { kind: 'completed', reason: 'end_turn' }, native: { ...native, blocks: [visible(0), visible(1)] } };
  assert.equal(modelReplyText(requireModelReply(textOnly)), 'firstsecond');
  for (const [reason, kind] of [
    ['refusal', 'refused'],
    ['max_tokens', 'incomplete'],
    ['unknown', 'incomplete'],
  ]) {
    const stopped = requireModelReply({ ...reply, termination: { kind, reason } });
    assert.throws(() => requireModelExchange({ reply: stopped, feedback: [{ toolCallId: 'a', status: 'ok', content: [text('result')] }] }), TypeError);
  }
});

test('Messages object inputs and layout are passive JSON before any protocol access', () => {
  let calls = 0;
  class ActiveArray extends Array {
    [Symbol.iterator]() {
      calls++;
      return super[Symbol.iterator]();
    }
  }
  const activeObject = Object.defineProperty({}, 'read', {
    enumerable: true,
    get() {
      calls++;
      return true;
    },
  });
  for (const value of [
    activeObject,
    { nested: new ActiveArray('data') },
    new Proxy(
      {},
      {
        ownKeys() {
          calls++;
          return [];
        },
      },
    ),
  ]) {
    assert.throws(() => requireModelReply({ ...reply, output: [text('before'), { ...call, arguments: { encoding: 'json-value', value } }, text('after')] }), TypeError);
  }
  assert.throws(() => requireModelReply({ ...reply, native: { ...native, blocks: new ActiveArray(...native.blocks) } }), TypeError);
  assert.equal(calls, 0);
});

test('persisted Chat v1 keeps raw arguments and its original output order rules', () => {
  const raw = { ...call, arguments: { encoding: 'json-text', text: 'invalid JSON' } };
  const chat = { ...reply, output: [text('before'), raw], termination: { kind: 'completed', reason: 'tool_calls' }, native: { format: 'chat-completions', version: 1, reasoningContent: 'prior reasoning' } };
  assert.deepEqual(requireModelReply(JSON.parse(JSON.stringify(chat))), chat);
  for (const output of [[raw, text('after')], [text('one'), text('two'), raw], [call]]) assert.throws(() => requireModelReply({ ...chat, output }), TypeError);
});

test('structural reservation accepts an exact fit before pending tool feedback adds nodes', () => {
  const request = { messages: [{ role: 'user', content: '' }] };
  // Request, messages array, message object, role, content.
  assert.doesNotThrow(() => assertModelRequestNodeCapacity(request, 100_000 - 5));
  assert.throws(() => assertModelRequestNodeCapacity(request, 100_000 - 4), /structural limits/);
  for (const count of [-1, 0.5, NaN, Infinity]) assert.throws(() => assertModelRequestNodeCapacity(request, count), RangeError);
});

test('Responses layout retains item IDs, output reference types, reasoning and refusal in native order', () => {
  const response = {
    formatVersion: 1,
    id: 'resp_first',
    model: 'resolved',
    output: [text('before'), { ...call, arguments: { encoding: 'json-text', text: '{bad' } }],
    termination: { kind: 'completed', reason: 'completed' },
    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5, promptCacheHitTokens: 1 },
    native: {
      format: 'openai-responses',
      version: 1,
      bindingId: 'scope',
      model: 'alias',
      continuation: 'replay',
      previousResponseId: null,
      prefixSha256: 'e'.repeat(64),
      items: [
        { kind: 'reasoning', id: 'reason', summary: ['summary'], encryptedContent: 'cipher' },
        { kind: 'message', id: 'msg', status: 'completed', phase: 'commentary', content: [{ kind: 'output_text', index: 0 }] },
        { kind: 'function_call', id: 'fc', index: 1, status: 'completed' },
      ],
    },
  };
  assert.equal(requireModelReply(response), response);
  const exchange = requireModelExchange({ reply: response, feedback: [{ toolCallId: 'a', status: 'ok', content: [text('pending')] }] });
  assert.throws(() => assertModelContinuation({ messages: [{ role: 'user', content: 'hello' }], exchanges: [exchange] }), { code: 'REQUEST' });
  for (const change of [(r) => (r.native.items[2].index = 0), (r) => (r.native.items[2].id = 'msg'), (r) => r.native.items.pop(), (r) => (r.native.items[2].status = 'incomplete'), (r) => (r.native.items[0].summary = [{}]), (r) => (r.native.items[1].content[0].kind = 'refusal'), (r) => (r.native.items[1].phase = 'unknown'), (r) => (r.native.previousResponseId = 'resp_earlier'), (r) => (r.native.prefixSha256 = 'bad'), (r) => (r.output[1].arguments = call.arguments), (r) => (r.usage.totalTokens = 4), (r) => (r.native.format = '__proto__'), (r) => (r.native.version = 2)]) {
    const broken = structuredClone(response);
    change(broken);
    assert.throws(() => requireModelReply(broken), TypeError);
  }
  const refused = structuredClone(response);
  refused.native.items[1].content.push({ kind: 'refusal', refusal: 'denied' });
  assert.throws(() => requireModelReply(refused), TypeError);
  refused.termination = { kind: 'refused', reason: 'refusal' };
  assert.equal(requireModelReply(refused), refused);
  assert.throws(() => requireModelExchange({ reply: refused, feedback: [] }), /cannot be continued/);
  const interrupted = structuredClone(response);
  interrupted.termination = { kind: 'incomplete', reason: 'max_output_tokens' };
  interrupted.native.items[2].status = 'incomplete';
  assert.equal(requireModelReply(interrupted), interrupted);
});

test('saved exchanges remain readable while mixed native history fails continuation before a sender is chosen', () => {
  const chat = { ...reply, output: [text('chat')], termination: { kind: 'completed', reason: 'stop' }, native: { format: 'chat-completions', version: 1 } };
  const messages = { ...reply, output: [text('messages')], termination: { kind: 'completed', reason: 'end_turn' }, native: { ...native, blocks: [visible(0)] } };
  const exchanges = [chat, messages].map((reply) => requireModelExchange({ reply, feedback: [] }));
  assert.throws(() => assertModelContinuation({ messages: [{ role: 'user', content: 'hello' }], exchanges }), { code: 'REQUEST' });
});

test('consumers read either tool argument representation and preserve the original for replay', () => {
  const encoded = { ...call, arguments: { encoding: 'json-text', text: ' { "city" : "上海" } ' } };
  assert.deepEqual(readModelToolArguments(encoded), readModelToolArguments(call));
  assert.equal(encoded.arguments.text, ' { "city" : "上海" } ');
  assert.equal(readModelToolArguments({ ...call, arguments: { encoding: 'json-text', text: 'null' } }), null);
  const invalid = { ...call, arguments: { encoding: 'json-text', text: 'private-invalid-input' } };
  assert.throws(() => readModelToolArguments(invalid), { name: 'SyntaxError', message: 'Model tool arguments contain invalid JSON' });
});
