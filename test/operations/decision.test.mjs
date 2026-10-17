import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript } from '@capix/server-runtime/content';
import { DefaultConversationDecisionDefinition, FunctionConversationDecisionDefinition } from '@capix/observer-service';
import { createBoundRuntime } from '../fixtures/runtime.mjs';
import { bindChild, resourceBindingFor } from '../fixtures/observer.mjs';
import { callFor, lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';

const settings = { model: 'fixture', contextBudget: 100000, maxOutputTokens: 1024, timeoutMs: 1000 };
const offer = (name) => ({ name, description: `${name} capability`, arguments: { type: 'object' } });
const available = ['checkFile', 'answer', 'document', 'save'].map(offer);
const answer = { kind: 'answer', content: '已生成正文。' };
const file = (task = { sourcePath: 'notes.md', output: { path: 'result.md' } }) => ({ kind: 'ready', task, instruction: '翻译为白话文。' });

async function decide({ definition = new DefaultConversationDecisionDefinition({ files: true }), progress = {}, latest, feedback, fileTask, proposal = { kind: 'reply' }, requests = [], offers = available } = {}) {
  const transcript = new Transcript([{ role: 'user', content: '把 notes.md 翻译为白话文，保存为 result.md' }]);
  const message = transcript.get(0);
  const runtime = createBoundRuntime();
  const operation = bindChild(runtime, definition);
  const input = { request: { message, selection: { historyIndexes: [] }, memories: [], ...(fileTask ? { fileTask } : {}) }, progress, available: offers, ...(latest ? { latest } : {}), ...(feedback ? { feedback } : {}) };
  const resourceBinding = resourceBindingFor(runtime, {
    async invoke(request, purpose) {
      assert.equal(purpose, 'understanding');
      requests.push(request);
      return { id: 'fixture', model: 'fixture', content: typeof proposal === 'string' ? proposal : JSON.stringify(proposal), finishReason: 'stop', usage: null };
    },
  });
  const result = await invoke(lifecycleFor(runtime).execution({ input: message, transcript, resourceBinding, settings }), (context) => operation.call(callFor(context), input));
  return { result, requests, input, transcript };
}

test('default decision advances accepted work without repeatedly invoking the model', async () => {
  const cases = [
    { progress: { file: file() }, expected: { kind: 'invoke', capability: 'document', arguments: {} } },
    { progress: { file: file({ output: { path: 'result.md' } }) }, expected: { kind: 'invoke', capability: 'answer', arguments: {} } },
    { progress: { file: file(), answer }, expected: { kind: 'invoke', capability: 'save', arguments: {} } },
    { progress: { file: file({ sourcePath: 'notes.md' }), answer }, expected: { kind: 'finish', conclusion: { kind: 'settled' } } },
    { progress: { file: file(), answer, saved: { path: 'result.md', bytes: 20, digest: 'fixture' } }, expected: { kind: 'finish', conclusion: { kind: 'settled' } } },
    { progress: { file: file(), answer: { kind: 'needs-info', content: '请补充翻译要求。' } }, expected: { kind: 'finish', conclusion: { kind: 'settled' } } },
  ];
  for (const item of cases) {
    const { result, requests } = await decide(item);
    assert.deepEqual(result, item.expected);
    assert.equal(requests.length, 0);
  }
});

test('an explicit file entry goes through preflight without being reinterpreted by a model', async () => {
  const fileTask = { sourcePath: 'notes.md', output: { path: 'result.md' } };
  const { result, requests } = await decide({ fileTask });
  assert.deepEqual(result, { kind: 'invoke', capability: 'checkFile', arguments: { task: fileTask, instruction: '把 notes.md 翻译为白话文，保存为 result.md' } });
  assert.equal(requests.length, 0);
});

test('accepted preflight evidence requiring user input closes with a clarification without a model call', async () => {
  const { result, requests } = await decide({ latest: { capability: 'checkFile', output: { kind: 'needs-input', reason: 'FILE_EXISTS', question: 'result.md 已存在，请指定新文件。' } } });
  assert.deepEqual(result, { kind: 'finish', conclusion: { kind: 'clarify', question: 'result.md 已存在，请指定新文件。' } });
  assert.equal(requests.length, 0);
});

test('a candidate needing revision is returned to understanding with real catalog and feedback', async () => {
  const latest = { capability: 'checkFile', output: { kind: 'revise', reason: 'SAME_PATH', feedback: '用户指定的目标是 result.md，请重新核对输出路径。' } };
  const proposal = { kind: 'file', task: { sourcePath: 'notes.md', output: { path: 'result.md' } }, instruction: '翻译并保存' };
  const { result, requests, transcript } = await decide({ latest, proposal });
  assert.deepEqual(result, { kind: 'invoke', capability: 'checkFile', arguments: { task: proposal.task, instruction: proposal.instruction } });
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(payload.available, available);
  assert.deepEqual(payload.feedback, { code: latest.output.reason, message: latest.output.feedback });
  assert.equal(transcript.length, 1, 'internal decision feedback is not a conversation message');
});

test('decision admission feedback takes precedence over older preflight feedback', async () => {
  const feedback = { code: 'UNAVAILABLE_CAPABILITY', message: '当前仅允许 answer。' };
  const { result, requests } = await decide({ feedback, latest: { capability: 'checkFile', output: { kind: 'revise', reason: 'OLD', feedback: 'older' } }, offers: [offer('answer')] });
  assert.deepEqual(result, { kind: 'invoke', capability: 'answer', arguments: {} });
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(payload.feedback, feedback);
  assert.equal(payload.capabilities.files, null);
});

test('default decision maps model proposals without claiming that proposed file work completed', async () => {
  for (const proposal of [{ kind: 'reply' }, { kind: 'clarify', question: '请说明源文件名。' }, { kind: 'unsupported', explanation: '不能删除文件。' }]) {
    const { result, requests } = await decide({ proposal });
    assert.equal(requests.length, 1);
    assert.deepEqual(result, proposal.kind === 'reply' ? { kind: 'invoke', capability: 'answer', arguments: {} } : { kind: 'finish', conclusion: proposal });
  }
});

test('disabled file mode has no model child or resource requests', async () => {
  const definition = new DefaultConversationDecisionDefinition({ files: false });
  assert.deepEqual(definition.children, []);
  assert.deepEqual(definition.run.requires, {});
  const { result, requests } = await decide({ definition });
  assert.deepEqual(result, { kind: 'invoke', capability: 'answer', arguments: {} });
  assert.equal(requests.length, 0);
});

test('a function decision uses the same operation contract and supports asynchronous policies', async () => {
  const inputs = [];
  const definition = new FunctionConversationDecisionDefinition(async (input) => {
    inputs.push(input);
    return { kind: 'invoke', capability: 'answer', arguments: {} };
  });
  assert.deepEqual(definition.children, []);
  assert.deepEqual(definition.run.requires, {});
  const { input, result, requests } = await decide({ definition });
  assert.equal(inputs[0], input);
  assert.deepEqual(result, { kind: 'invoke', capability: 'answer', arguments: {} });
  assert.equal(requests.length, 0);
});

test('decision output parsing failures do not become another model decision in the same call', async () => {
  const requests = [];
  await assert.rejects(decide({ proposal: 'not JSON', requests }), (error) => error.exception?.code === 'MODEL_OUTPUT_REJECTED');
  assert.equal(requests.length, 1);
});
