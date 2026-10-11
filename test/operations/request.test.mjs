import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript } from '@capix/server-runtime/content';
import { UnderstandRequestDefinition, requestOutputContract, acceptRequestProposal } from '@capix/observer-service';
import { createBoundRuntime } from '../fixtures/runtime.mjs';
import { bindChild, resourceBindingFor } from '../fixtures/observer.mjs';
import { callFor, lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';

const settings = { model: 'fixture', contextBudget: 100000, maxOutputTokens: 1024, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'fixture', content: typeof value === 'string' ? value : JSON.stringify(value), finishReason: 'stop', usage: null });
const file = (task = { sourcePath: 'notes.md', output: { path: 'translation.md' } }) => ({ kind: 'file', task, instruction: '把 notes.md 翻译成白话文。' });

async function understand({ messages = [{ role: 'user', content: '请翻译 notes.md 并保存为 translation.md' }], selection = [], files = true, proposal = file(), memories = [], contextBudget = settings.contextBudget, requests = [] } = {}) {
  const transcript = new Transcript(messages);
  const message = transcript.get(transcript.length - 1);
  const runtime = createBoundRuntime();
  const definition = new UnderstandRequestDefinition({ files });
  const operation = bindChild(runtime, definition);
  const resourceBinding = resourceBindingFor(runtime, {
    async invoke(request, purpose) {
      assert.equal(purpose, 'understanding');
      requests.push(request);
      return raw(proposal);
    },
  });
  const input = { message, selection: { historyIndexes: selection }, memories };
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

test('parent acceptance copies and freezes executable file ranges without normalizing paths', () => {
  const proposal = file();
  const accepted = acceptRequestProposal(proposal, { files: true });
  assert.deepEqual(accepted, proposal);
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.task));
  assert.ok(Object.isFrozen(accepted.task.output));
  proposal.task.output.path = 'changed.md';
  assert.equal(accepted.task.output.path, 'translation.md');
});

test('invalid file paths and overwriting the source become clarification before resource access', () => {
  for (const task of [{ sourcePath: '../notes.md' }, { sourcePath: '/tmp/notes.md' }, { output: { path: 'a\\b.md' } }, { sourcePath: 'notes.md', output: { path: 'notes.md' } }]) {
    assert.equal(acceptRequestProposal(file(task), { files: true }).kind, 'clarify');
  }
});

test('parent acceptance cannot silently add, remove or replace explicitly requested operations', () => {
  const fileTask = { sourcePath: 'notes.md' };
  assert.deepEqual(acceptRequestProposal(file(fileTask), { files: true, fileTask }), file(fileTask));
  for (const proposal of [file(), file({ sourcePath: 'other.md' }), file({ output: { path: 'notes.md' } }), { kind: 'reply' }, { kind: 'unsupported', explanation: '历史助手曾说没有文件能力。' }]) {
    assert.equal(acceptRequestProposal(proposal, { files: true, fileTask }).kind, 'clarify');
  }
  assert.equal(acceptRequestProposal({ kind: 'clarify', question: '请确认处理目标。' }, { files: true, fileTask }).kind, 'clarify');
});

test('file candidate cannot enable an unavailable capability', () => {
  assert.equal(acceptRequestProposal(file(), { files: false }).kind, 'unsupported');
  assert.deepEqual(acceptRequestProposal({ kind: 'reply' }, { files: false }), { kind: 'reply' });
});

test('request understanding only prepares and invokes the model, leaving parent acceptance separate', async () => {
  const proposal = file({ sourcePath: '../notes.md' });
  const { result, definition, transcript } = await understand({ proposal });
  assert.deepEqual(result, proposal);
  assert.equal(acceptRequestProposal(result, { files: true }).kind, 'clarify');
  assert.equal(transcript.length, 1);
  assert.deepEqual(
    definition.children.map((child) => child.name),
    ['prepareModelRequest', 'invokeModel', 'acceptModelOutput'],
  );
  assert.ok(Object.values(definition.run.requires).every((request) => !request.offer.name.startsWith('workspace-files')));
});

test('recent clarification remains visible even if the history selection misses it', async () => {
  const messages = [
    { role: 'user', content: '旧话题' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '翻译 notes.md 并保存' },
    { role: 'assistant', content: '保存为什么文件名？' },
    { role: 'user', content: 'translation.md' },
  ];
  const { requests } = await understand({ messages, selection: [0] });
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(
    payload.history,
    [0, 2, 3].map((index) => ({ index, ...messages[index] })),
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

test('malformed model output is rejected without automatic regeneration', async () => {
  const requests = [];
  await assert.rejects(understand({ proposal: 'not JSON', requests }), (error) => error.code === 'MODEL_OUTPUT_REJECTED');
  assert.equal(requests.length, 1);
});

test('understanding rejects selected references outside the current fixed history before invoking the model', async () => {
  for (const selection of [[-1], [0], [100], [0.5]]) {
    const requests = [];
    await assert.rejects(understand({ selection, requests }), /outside/);
    assert.equal(requests.length, 0);
  }
});
