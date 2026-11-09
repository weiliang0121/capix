import { createConversationRunner } from '../fixtures/conversation-runner.mjs';
import { ActiveView } from '@capix/observer-content';
import { ModelInteractions, ModelSource } from '@capix/observer-service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeObserver, ObserverConversations, createConversationStructure, FunctionConversationDecision, WorkspaceFiles } from '@capix/observer-service';
import { ProgressChannel } from '@weiliang0121/capix-changes';
import { Transcript } from '@weiliang0121/capix-transcript';
import { Memories } from '@weiliang0121/capix-memory';
import { MessageUsage } from '@weiliang0121/capix-measurement';
import { CallableRecordHelper } from '@weiliang0121/capix-records';
import { validateExecutionRecordSnapshot } from '@weiliang0121/capix-protocol';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const answer = { kind: 'answer', content: '完成的正文。' };
const invoke = (capability, arguments_ = {}) => ({ kind: 'invoke', capability, arguments: arguments_ });
const finish = () => ({ kind: 'finish', conclusion: { kind: 'settled' } });
const inspect = (task) => invoke('checkFile', { task, instruction: '处理文件内容。' });
const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });

async function fixture(t, decide, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'capix-decision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'input.txt'), '来源正文。');
  const files = new WorkspaceFiles({ root });
  const inputs = [];
  const modelCalls = [];
  const progress = [];
  const fileProgress = [];
  const decision = {
    create: () =>
      new FunctionConversationDecision(async (input) => {
        inputs.push(input);
        return decide(input, { root, files, index: inputs.length - 1 });
      }),
  };
  const provider = {
    async invoke(request, purpose) {
      modelCalls.push({ request, purpose });
      if (purpose === 'selection') return output({ historyIndexes: [] });
      if (purpose === 'memory') return output(options.memory ? options.memory(JSON.parse(request.messages[1].content)) : { memories: [] });
      assert.equal(purpose, 'answer', 'function decisions must not invoke an understanding model');
      if (options.answerFails) throw options.answerFails;
      return output(answer);
    },
  };
  const config = { files, decision, maxDecisionSteps: options.maxDecisionSteps ?? 16 };
  const environment =
    options.recording === false
      ? (() => {
          const transcript = new Transcript();
          const memories = new Memories(transcript);
          const entities = { transcript, memories, active: new ActiveView(transcript, memories), messageUsage: new MessageUsage(), files };
          const definition = createConversationStructure({ files: true, decision, maxDecisionSteps: config.maxDecisionSteps });

          const runner = createConversationRunner(definition, entities, new ModelInteractions(new ModelSource(provider)));
          return { ...entities, runner, scene: runner.scene };
        })()
      : initializeObserver(provider, [], config);
  return {
    root,
    environment,
    inputs,
    modelCalls,
    progress,
    fileProgress,
    run: (message = '处理一下', fileTask, signal) =>
      environment.runner.run(
        { messages: [{ role: 'user', content: message }], ...(fileTask ? { fileTask } : {}) },
        {
          settings,
          signal,
          progress: new ProgressChannel({
            receive: (fact) => {
              progress.push(fact);
            },
          }),
          fileProgress: new ProgressChannel({
            receive: (fact) => {
              fileProgress.push(fact);
            },
          }),
        },
      ),
  };
}

const ordinary = (input) => (input.progress.answer ? finish() : invoke('answer'));
const filePolicy = (task) => (input) => {
  if (!input.progress.file) return inspect(task);
  if (!input.progress.answer) return invoke(task.sourcePath ? 'document' : 'answer');
  if (task.output && !input.progress.saved) return invoke('save');
  return finish();
};

for (const recording of [true, false]) {
  test(`function decisions run through child delivery without an understanding model (${recording ? 'recorded' : 'without recording'})`, async (t) => {
    const f = await fixture(t, ordinary, { recording });
    assert.deepEqual(await f.run('你好'), answer);
    assert.deepEqual(
      f.modelCalls.map((call) => call.purpose),
      ['answer', 'memory'],
    );
    assert.equal(f.inputs.length, 2);
    assert.equal(f.inputs[1].latest.capability, 'answer');
    assert.deepEqual(f.inputs[1].progress.answer, answer);
    assert.equal(f.environment.transcript.length, 2);
    assert.equal(f.environment.runner.isRunning, false);
    if (!recording) assert.equal(f.environment.records, undefined);
  });
}

for (const [proposal, code] of [
  [invoke('unregistered'), 'UNAVAILABLE_CAPABILITY'],
  [invoke('answer', { text: 'invented input' }), 'CAPABILITY_ARGUMENTS'],
  [finish(), 'UNSETTLED'],
  [{ kind: 'finish', conclusion: { kind: 'settled', output: 'invented success' } }, 'DECISION_SHAPE'],
]) {
  test(`invalid decision is accepted as revision feedback before any selected work: ${code}`, async (t) => {
    const f = await fixture(t, (input, { index }) => (index === 0 ? proposal : ordinary(input)));
    assert.deepEqual(await f.run(), answer);
    assert.equal(f.inputs[1].feedback.code, code);
    assert.deepEqual(f.inputs[1].progress, {});
    assert.equal(f.inputs[1].latest, undefined);
    assert.equal(f.modelCalls.filter((call) => call.purpose === 'answer').length, 1);
    assert.deepEqual(
      f.progress.filter((fact) => fact.kind === 'task').map((fact) => fact.task),
      [{ kind: 'reply' }],
    );
  });
}

test('explicit file work cannot bypass preflight or revise the user-supplied file target', async (t) => {
  const task = { sourcePath: 'input.txt', output: { path: 'result.md' } };
  const proposals = [invoke('document'), invoke('answer'), inspect({ ...task, output: { path: 'other.md' } }), inspect(task), invoke('document'), invoke('save'), finish()];
  const f = await fixture(t, (_input, { index }) => proposals[index]);
  assert.deepEqual(await f.run('处理并保存', task), answer);
  assert.equal(f.inputs[1].feedback.code, 'UNAVAILABLE_CAPABILITY');
  assert.equal(f.inputs[2].feedback.code, 'UNAVAILABLE_CAPABILITY');
  assert.equal(f.inputs[3].latest.output.kind, 'revise');
  assert.equal(f.inputs[3].latest.output.reason, 'constraint');
  assert.equal(f.inputs[3].progress.file, undefined);
  assert.deepEqual((await readdir(f.root)).sort(), ['input.txt', 'result.md']);
  assert.equal(await readFile(join(f.root, 'result.md'), 'utf8'), answer.content);
  assert.deepEqual(
    f.progress.filter((fact) => fact.kind === 'task').map((fact) => fact.task),
    [{ kind: 'file', task }],
  );
});

for (const recording of [true, false]) {
  test(`accepted file receipts become memory sources and later model context (${recording ? 'recorded' : 'without recording'})`, async (t) => {
    const task = { sourcePath: 'input.txt', output: { path: 'result.md' } };
    const policy = filePolicy(task);
    const f = await fixture(t, (input) => (input.request.message.content === '处理并保存' ? policy(input) : ordinary(input)), {
      recording,
      memory: (input) => {
        if (!input.results) return { memories: [] };
        const source = input.results[0];
        assert.equal(source.kind, 'file-created');
        assert.equal(source.answerIndex, input.currentIndexes[1]);
        assert.deepEqual(source.receipt, f.fileProgress.find((fact) => fact.kind === 'created').receipt);
        return { memories: [{ action: 'create', memoryId: null, change: '本轮正文已创建到结果文件。', sourceIndexes: input.currentIndexes, sourceResultIds: [source.id], result: { topic: '文件处理结果', content: '本轮生成的正文曾保存到 result.md。', sourceIndexes: input.currentIndexes, sourceResultIds: [source.id] } }] };
      },
    });
    await f.run('处理并保存');
    const memory = f.environment.memories.values()[0].toJSON();
    const source = memory.sourceResults[0];
    assert.ok(source.id.length > 0);
    assert.equal(source.receipt.path, 'result.md');
    assert.equal(source.receipt.bytes, Buffer.byteLength(answer.content));
    assert.equal('sourceResultIds' in memory, false);
    assert.equal(await readFile(join(f.root, source.receipt.path), 'utf8'), answer.content);
    await rm(join(f.root, source.receipt.path));
    const previousCount = f.modelCalls.length;
    await f.run('刚才的结果在哪里');
    for (const call of f.modelCalls.slice(previousCount)) {
      const input = JSON.parse(call.request.messages[1].content);
      assert.deepEqual(input.memories[0].sourceResults, [source]);
      assert.match(call.request.messages[0].content, /不保证文件当前仍存在/);
      assert.equal(input.results, undefined, 'an old result remains on its memory, not a new accepted operation');
    }
    assert.deepEqual(f.environment.memories.values()[0].toJSON(), memory);
    if (!recording) assert.equal(f.environment.records, undefined);
  });
}

test('preflight candidates and unsaved answers do not become operation sources', async (t) => {
  const f = await fixture(t, (input) => (!input.latest ? inspect({ sourcePath: 'missing.txt' }) : ordinary(input)));
  await f.run();
  assert.equal(f.inputs[1].latest.output.kind, 'needs-input');
  const input = JSON.parse(f.modelCalls.find((call) => call.purpose === 'memory').request.messages[1].content);
  assert.equal(input.results, undefined);
  assert.equal(f.fileProgress.length, 0);
});

test('forged memory source after publication preserves the file and answer without partially applying memories or repeating save', async (t) => {
  const task = { output: { path: 'result.md' } };
  const f = await fixture(t, filePolicy(task), {
    memory: (input) => {
      const proposal = (id) => ({ action: 'create', memoryId: null, change: '保留保存结果', sourceIndexes: input.currentIndexes, sourceResultIds: [id], result: { topic: '文件处理', content: '结果已保存到 result.md。', sourceIndexes: input.currentIndexes, sourceResultIds: [id] } });
      return { memories: [proposal(input.results[0].id), proposal('invented-source')] };
    },
  });
  await assert.rejects(f.run('生成并保存'), { code: 'MEMORY_SOURCE' });
  assert.equal(await readFile(join(f.root, task.output.path), 'utf8'), answer.content);
  assert.deepEqual(f.environment.transcript.snapshot(), [
    { role: 'user', content: '生成并保存' },
    { role: 'assistant', content: answer.content },
  ]);
  assert.equal(f.environment.runner.isRunning, false);
  assert.equal(f.environment.memories.values().length, 0, 'a valid first proposal must not be applied before the invalid second proposal is checked');
  assert.equal(f.fileProgress.filter((fact) => fact.kind === 'created').length, 1);
  assert.equal(f.modelCalls.filter((call) => call.purpose === 'answer').length, 1);
  assert.equal(f.modelCalls.filter((call) => call.purpose === 'memory').length, 1);
  assert.equal([...f.environment.records.book.values()].filter((record) => record.kind === 'invocation' && record.name === 'saveResult').length, 1);
});

test('decisions cannot replace save arguments, repeat answer/save effects, or finish before the promised save', async (t) => {
  const task = { output: { path: 'result.md' } };
  const proposals = [inspect(task), invoke('answer'), finish(), invoke('answer'), invoke('save', { path: 'other.md', text: 'forged' }), invoke('save'), invoke('save'), finish()];
  const f = await fixture(t, (_input, { index }) => proposals[index]);
  assert.deepEqual(await f.run('写入结果'), answer);
  assert.equal(f.inputs[3].feedback.code, 'UNSETTLED');
  assert.equal(f.inputs[4].feedback.code, 'UNAVAILABLE_CAPABILITY');
  assert.equal(f.inputs[5].feedback.code, 'CAPABILITY_ARGUMENTS');
  assert.equal(f.inputs[7].feedback.code, 'UNAVAILABLE_CAPABILITY');
  assert.equal(f.modelCalls.filter((call) => call.purpose === 'answer').length, 1);
  assert.equal(f.fileProgress.filter((fact) => fact.kind === 'created').length, 1);
  assert.deepEqual((await readdir(f.root)).sort(), ['input.txt', 'result.md']);
  assert.equal(await readFile(join(f.root, 'result.md'), 'utf8'), answer.content);
  assert.equal(f.environment.transcript.length, 2);
});

function tryMutation(work) {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof TypeError);
  }
}

test('decision input snapshots cannot rewrite accepted progress, published task, or saved content', async (t) => {
  const task = { sourcePath: 'input.txt', output: { path: 'result.md' } };
  const f = await fixture(t, (input, { index }) => {
    if (index === 0) return inspect(task);
    if (index === 1) {
      tryMutation(() => {
        input.progress.file.task.output.path = 'forged.md';
      });
      tryMutation(() => {
        input.latest.output.task.sourcePath = 'missing.txt';
      });
      return invoke('document');
    }
    if (index === 2) {
      assert.deepEqual(input.progress.file.task, task);
      tryMutation(() => {
        input.progress.answer.content = 'forged answer';
      });
      tryMutation(() => {
        input.latest.output.content = 'forged answer';
      });
      return invoke('save');
    }
    assert.deepEqual(input.progress.answer, answer);
    assert.equal(input.progress.saved.path, task.output.path);
    tryMutation(() => {
      input.progress.saved.path = 'forged.md';
    });
    return finish();
  });
  assert.deepEqual(await f.run(), answer);
  assert.equal(await readFile(join(f.root, 'result.md'), 'utf8'), answer.content);
  assert.equal(f.environment.transcript.get(1).content, answer.content);
  assert.deepEqual(
    f.progress.filter((fact) => fact.kind === 'task').map((fact) => fact.task),
    [{ kind: 'file', task }],
  );
  assert.equal(f.fileProgress.find((fact) => fact.kind === 'created').receipt.path, task.output.path);
});

test('decision limit stops unresolved proposals without inventing an answer or retaining runtime occupancy', async (t) => {
  const f = await fixture(t, () => finish(), { maxDecisionSteps: 3 });
  await assert.rejects(f.run(), { code: 'DECISION_LIMIT' });
  assert.equal(f.inputs.length, 3);
  assert.equal(f.environment.transcript.length, 1);
  assert.equal(f.environment.runner.isRunning, false);
  assert.deepEqual(
    f.modelCalls.map((call) => call.purpose),
    [],
  );
});

test('actual child failures terminate execution rather than requesting another decision', async (t) => {
  const failure = new Error('model connection failed');
  const f = await fixture(t, ordinary, { answerFails: failure });
  await assert.rejects(f.run());
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(
    f.modelCalls.map((call) => call.purpose),
    ['answer'],
  );
  assert.equal(f.environment.transcript.length, 1);
  assert.equal(f.environment.runner.isRunning, false);
});

for (const checked of [false, true]) {
  test(`cancellation while deciding ${checked ? 'after preflight' : 'before work'} waits for the active decision and starts no next capability`, { timeout: 2000 }, async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const controller = new AbortController();
    const task = { sourcePath: 'input.txt', output: { path: 'result.md' } };
    const f = await fixture(t, async (input, { index }) => {
      if (checked && index === 0) return inspect(task);
      assert.equal(Boolean(input.progress.file), checked);
      entered.resolve();
      await release.promise;
      return invoke(checked ? 'document' : 'answer');
    });
    const running = f.run('处理文件', undefined, controller.signal);
    const rejected = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    assert.equal(f.environment.runner.isRunning, true, 'abort must not release occupancy before the active child actually exits');
    release.resolve();
    await rejected;
    assert.equal(f.environment.runner.isRunning, false);
    assert.equal(f.inputs.length, checked ? 2 : 1);
    assert.deepEqual(
      f.modelCalls.map((call) => call.purpose),
      [],
    );
    assert.equal(f.environment.transcript.length, 1);
    assert.deepEqual(await readdir(f.root), ['input.txt']);
    assert.deepEqual(f.fileProgress, []);
    assert.equal(
      f.progress.some((fact) => fact.kind === 'task'),
      false,
    );
  });
}

test('reused decision and runtime declarations start each execution with independent progress', async (t) => {
  const f = await fixture(t, ordinary);
  await f.run('第一轮');
  await f.run('第二轮');
  assert.equal(f.inputs.length, 4);
  for (const index of [0, 2]) {
    assert.deepEqual(f.inputs[index].progress, {});
    assert.equal(f.inputs[index].latest, undefined);
    assert.equal(f.inputs[index].feedback, undefined);
    assert.ok(f.inputs[index].available.some((offer) => offer.name === 'answer'));
  }
  assert.equal(f.inputs[0].request.message.content, '第一轮');
  assert.equal(f.inputs[2].request.message.content, '第二轮');
  assert.equal(f.environment.transcript.length, 4);
});

for (const phase of ['read', 'create']) {
  test(`successful preflight does not authorize stale ${phase} conditions`, async (t) => {
    const task = { sourcePath: 'input.txt', output: { path: 'result.md' } };
    const policy = filePolicy(task);
    const f = await fixture(t, async (input, { root }) => {
      if (phase === 'read' && input.progress.file && !input.progress.answer) await rm(join(root, 'input.txt'));
      if (phase === 'create' && input.progress.answer && !input.progress.saved) await writeFile(join(root, task.output.path), 'created after preflight');
      return policy(input);
    });
    await assert.rejects(f.run());
    assert.equal(f.inputs.length, phase === 'read' ? 2 : 3, 'an actual I/O failure does not enter the decision loop again');
    assert.equal(f.environment.runner.isRunning, false);
    assert.equal(
      f.modelCalls.some((call) => call.purpose === 'memory'),
      false,
    );
    assert.equal(f.environment.memories.values().length, 0);
    if (phase === 'create') {
      assert.equal(await readFile(join(f.root, task.output.path), 'utf8'), 'created after preflight');
      assert.equal(f.environment.transcript.get(1).content, answer.content);
    } else assert.equal(f.environment.transcript.length, 1);
  });
}

test('decision, preflight and selected work remain real recorded calls with accepted parent delivery', async (t) => {
  const task = { sourcePath: 'input.txt', output: { path: 'result.md' } };
  const f = await fixture(t, filePolicy(task));
  await f.run();
  const execution = [...f.environment.records.book.values()].find((record) => record.kind === 'invocation' && record.role === 'conversation-task');
  const snapshot = CallableRecordHelper.snapshot(f.environment.records.recorder, execution.id);
  validateExecutionRecordSnapshot(snapshot);
  assert.equal(snapshot.execution.status, 'succeeded');
  const direct = snapshot.calls.filter((record) => record.parentId === snapshot.execution.id);
  assert.deepEqual(
    direct.map((record) => record.name),
    ['prepareContext', 'conversationDecision', 'checkFileTask', 'conversationDecision', 'processDocument', 'conversationDecision', 'saveResult', 'conversationDecision', 'memory'],
  );
  const preflight = direct.find((record) => record.name === 'checkFileTask');
  assert.ok(snapshot.calls.some((record) => record.parentId === preflight.id && record.name === 'inspectFileTask'));
  for (const record of direct) {
    assert.equal(record.status, 'succeeded');
    assert.ok(snapshot.execution.value.relationChanges.some((change) => change.identity.childContextId === record.contextId && change.change.kind === 'accepted'));
  }
});

test('conversation hosts reuse decision factories while keeping each scene structure distinct', () => {
  const decisions = [];
  const host = new ObserverConversations(
    {
      invoke() {
        throw new Error('No model call expected');
      },
    },
    [],
    {
      decision: {
        create() {
          const decision = new FunctionConversationDecision(ordinary);
          decisions.push(decision);
          return decision;
        },
      },
    },
  );
  try {
    const first = host.open(host.list().defaultConversationId);
    const second = host.open(host.create().id);
    assert.equal(decisions.length, 2);
    assert.notEqual(decisions[0], decisions[1]);
    assert.equal(first.structure.decision, decisions[0]);
    assert.equal(second.structure.decision, decisions[1]);
    assert.equal(first.scene, first.structure.scene);
    assert.equal(second.scene, second.structure.scene);
  } finally {
    host.close();
  }
});
