import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript } from '@capix/server-runtime/content';
import { ChildCallFailure } from '@capix/server-runtime';
import { UnderstandRequest, requestOutputContract } from '@capix/observer-service';
import { createBoundRuntime } from '../fixtures/runtime.mjs';
import { bindChild, resourceBindingFor } from '../fixtures/observer.mjs';
import { callFor, lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';

const settings = { model: 'fixture', contextBudget: 100000, maxOutputTokens: 1024, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'fixture', content: typeof value === 'string' ? value : JSON.stringify(value), finishReason: 'stop', usage: null });
const file = (task = { sourcePath: 'notes.md', output: { path: 'translation.md' } }) => ({ kind: 'file', task, instruction: '把 notes.md 翻译成白话文。' });

async function understand({ messages = [{ role: 'user', content: '请翻译 notes.md 并保存为 translation.md' }], history, files = true, proposal = file(), memories = [], available, feedback, progress, contextBudget = settings.contextBudget, requests = [] } = {}) {
  const transcript = new Transcript(messages);
  const message = transcript.get(transcript.length - 1);
  const runtime = createBoundRuntime();
  const definition = new UnderstandRequest({ files });
  const operation = bindChild(runtime, definition);
  const resourceBinding = resourceBindingFor(runtime, {
    async invoke(request, purpose) {
      assert.equal(purpose, 'understanding');
      requests.push(request);
      return raw(proposal);
    },
  });
  const input = { message, history: history ?? messages.slice(0, -1).map((message, index) => ({ index, message })), memories, ...(available ? { available } : {}), ...(feedback ? { feedback } : {}), ...(progress ? { progress } : {}) };
  const result = await invoke(lifecycleFor(runtime).execution({ input: message, transcript, resourceBinding, settings: { ...settings, contextBudget } }), (context) => operation.call(callFor(context), input));
  return { result, requests, definition, transcript };
}

test('understanding accepts four strict candidate shapes, including generation without a source file', () => {
  const proposals = [{ kind: 'reply' }, file(), file({ sourcePath: 'notes.md' }), file({ output: { path: 'poem.md' } }), { kind: 'clarify', question: '保存为什么文件名？' }, { kind: 'unsupported', explanation: '当前不支持删除文件。' }];
  for (const proposal of proposals) assert.deepEqual(requestOutputContract.accept(proposal), proposal);
  for (const invalid of [
    { kind: 'reply', task: {} },
    { kind: 'file', task: {}, instruction: '处理' },
    { kind: 'file', task: { sourcePath: 'x', overwrite: true }, instruction: '处理' },
    { kind: 'file', task: { sourcePath: 'x' } },
    { kind: 'file', task: { sourcePath: 'x' }, instruction: ' ' },
    { kind: 'file', task: { output: { path: 'x', overwrite: true } }, instruction: '处理' },
    { kind: 'clarify', question: null },
    { kind: 'unsupported', explanation: 1 },
    { kind: 'dynamic', steps: [] },
  ]) {
    assert.throws(
      () => requestOutputContract.accept(invalid),
      (error) => error.code === 'OUTPUT_SHAPE',
    );
  }
  const schema = JSON.stringify(requestOutputContract.schema);
  assert.match(schema, /additionalProperties/);
  assert.match(schema, /instruction/);
});

test('request understanding only proposes a candidate, leaving path eligibility to the declared preflight', async () => {
  const proposal = file({ sourcePath: '../notes.md' });
  const { result, definition, transcript } = await understand({ proposal });
  assert.deepEqual(result, proposal);
  assert.equal(transcript.length, 1);
  assert.deepEqual(
    definition.members.map((child) => child.name),
    ['prepareModelRequest', 'requestModel', 'acceptModelOutput'],
  );
  assert.ok(Object.values(definition.deps).every((request) => !request.offer.name.startsWith('workspace-files')));
});

test('understanding uses exactly the fixed active material without implicit recent-history expansion', async () => {
  const messages = [
    { role: 'user', content: '旧话题' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '翻译 notes.md 并保存' },
    { role: 'assistant', content: '保存为什么文件名？' },
    { role: 'user', content: 'translation.md' },
  ];
  const { requests } = await understand({ messages, history: [2, 0].map((index) => ({ index, message: messages[index] })) });
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(
    payload.history,
    [2, 0].map((index) => ({ index, ...messages[index] })),
  );
  assert.deepEqual(payload.message, messages.at(-1));
  assert.equal(payload.capabilities.files.createText, true);
  assert.equal('document' in payload, false);
  assert.match(requests[0].messages[0].content, /既往写入或“继续”不能自动授权/);
  assert.match(requests[0].messages[0].content, /本次还没有读取任何文件/);
});

test('current capability description is explicit even when historical assistant text denies it', async () => {
  const messages = [
    { role: 'user', content: '能处理文件吗' },
    { role: 'assistant', content: '没有文件能力' },
    { role: 'user', content: '读取 notes.md' },
  ];
  for (const files of [true, false]) {
    const { requests } = await understand({ messages, files });
    const payload = JSON.parse(requests[0].messages[1].content);
    assert.equal(Boolean(payload.capabilities.files), files);
    assert.match(requests[0].messages[0].content, /capabilities 是服务当前真实可用的能力/);
  }
});

test('request understanding does not invoke the model when the fixed request exceeds budget', async () => {
  const requests = [];
  await assert.rejects(understand({ contextBudget: 256, requests }), (error) => error.code === 'CAPACITY_EXCEEDED');
  assert.equal(requests.length, 0);
});

test('understanding receives the current capability contract and preflight feedback without adding them to history', async () => {
  const available = [{ name: 'checkFile', description: '检查候选文件路径', arguments: { type: 'object', properties: { task: { type: 'object' } } } }];
  const feedback = { code: 'SAME_PATH', message: '请从用户要求中重新选择保存路径。' };
  const progress = { file: { sourcePath: 'notes.md' } };
  const { requests, transcript } = await understand({ available, feedback, progress });
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(payload.available, available);
  assert.deepEqual(payload.feedback, feedback);
  assert.deepEqual(payload.progress, progress);
  assert.deepEqual(payload.history, []);
  assert.equal(transcript.length, 1);
  assert.match(requests[0].messages[0].content, /用户提供的配置根内绝对路径/);
  assert.match(requests[0].messages[0].content, /不要自行发明输出路径/);
  assert.match(requests[0].messages[0].content, /预检通过并不意味着已读取正文或已保存/);
});

test('a provided capability directory controls file availability at this decision point', async () => {
  const { requests } = await understand({ available: [{ name: 'answer', description: '回答', arguments: { type: 'object' } }] });
  assert.equal(JSON.parse(requests[0].messages[1].content).capabilities.files, null);
});

test('malformed model output is rejected without automatic regeneration', async () => {
  const requests = [];
  await assert.rejects(understand({ proposal: 'not JSON', requests }), (error) => error instanceof ChildCallFailure && error.exception.code === 'MODEL_OUTPUT_REJECTED');
  assert.equal(requests.length, 1);
});

test('understanding rejects invalid or duplicate material indexes before invoking the model', async () => {
  for (const indexes of [[-1], [0.5], [0, 0]]) {
    const requests = [];
    const history = indexes.map((index) => ({ index, message: { role: 'user', content: '材料' } }));
    await assert.rejects(understand({ history, requests }));
    assert.equal(requests.length, 0);
  }
});

test('understanding refuses an oversized complete active history instead of silently truncating it', async () => {
  const history = [{ index: 10, message: { role: 'assistant', content: '完整背景'.repeat(600) } }];
  const { requests: complete } = await understand({ history });
  const required = Buffer.byteLength(JSON.stringify(complete[0]), 'utf8') + 256 + complete[0].max_tokens;
  const requests = [];
  await assert.rejects(understand({ history, contextBudget: required - 1, requests }), (error) => error.code === 'CAPACITY_EXCEEDED');
  assert.equal(requests.length, 0);
  assert.deepEqual(
    JSON.parse(complete[0].messages[1].content).history,
    history.map(({ index, message }) => ({ index, ...message })),
  );
});
