import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDeclaration, BoundChildren, BoundReceptions, decodeCheckpointFrame, savedCheckpointFacts } from '@capix/server-runtime/construction';
import { initializeObserver, WorkspaceFiles } from '@capix/observer-service/assembly';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1024, timeoutMs: 1000 };
const answer = { kind: 'answer', content: '已整理的正文。' };

async function captureExecution(t, fileTask) {
  let files;
  if (fileTask) {
    const directory = mkdtempSync(join(tmpdir(), 'capix-cp-execution-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'source.md'), '原始资料');
    files = new WorkspaceFiles({ root: directory });
  }
  const environment = initializeObserver({ invoke: async (_request, purpose) => ({ id: 'feedback', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : answer), finishReason: 'stop', usage: null }) }, [], { files });
  t.after(() => environment.close());
  const images = [];
  const save = environment.checkpoints.save.bind(environment.checkpoints);
  environment.checkpoints.save = (image, revision) => {
    const result = save(image, revision);
    if (image.contract.key === 'observer.conversation.task') images.push(environment.checkpoints.read(result.contextId).image);
    return result;
  };
  await environment.runner.run({ messages: [{ role: 'user', content: '整理资料' }], ...(fileTask ? { fileTask } : {}) }, { settings });
  const definition = environment.structure.conversation;
  const resolved = resolveDeclaration(definition, {});
  const children = new BoundChildren(resolved.members, () => assert.fail('validation must not initialize children'));
  const receptions = new BoundReceptions(resolved.declaration.checkpoint.receptions, children);
  const check = (image) => {
    const point = definition.checkpoint.points.find((point) => point.name === image.point);
    const decoded = decodeCheckpointFrame(image.frame, definition.checkpoint, children.checkpointLayout(), receptions.bindings());
    const query = savedCheckpointFacts(decoded, image.references, children, receptions);
    try {
      point.check?.(point.state.decode(image.state), query.facts);
    } finally {
      query.close();
    }
  };
  return { check, images };
}

test('an accepted answer cannot be relabelled as completed before memory reception', async (t) => {
  const { check, images } = await captureExecution(t);
  const answerAccepted = images.find((image) => image.point === 'capabilityAccepted.answer');
  const completed = images.find((image) => image.point === 'completed');
  assert.ok(answerAccepted);
  assert.ok(completed);
  assert.ok(!answerAccepted.frame.children.some((child) => child.key === 'extraction'));
  assert.doesNotThrow(() => check(answerAccepted));
  assert.doesNotThrow(() => check(completed));
  // The former generic progress check accepted this valid earlier state and skipped memory work.
  assert.throws(() => check({ ...answerAccepted, point: 'completed', references: completed.references }), /Saved child reference|exactly one|completed|extraction/i);
});

test('capability continuation preserves the input selected by its accepted decision and progress', async (t) => {
  const { check, images } = await captureExecution(t, { sourcePath: 'source.md', output: { path: 'result.md' } });
  const waiting = images.filter((image) => image.point.startsWith('capabilityWaiting.'));
  assert.deepEqual(
    waiting.map((image) => image.state.capability),
    ['checkFile', 'document', 'save'],
  );
  for (const image of waiting) {
    assert.doesNotThrow(() => check(image));
    const changed = structuredClone(image);
    const child = changed.frame.children.at(-1);
    if (image.state.capability === 'checkFile') child.input.instruction = '不属于已接纳候选的指令';
    else if (image.state.capability === 'document') child.input.sourcePath = 'different.md';
    else child.input.text = '不属于已接纳回答的正文';
    assert.throws(() => check(changed), /Capability continuation changed its fixed input/, image.state.capability);
  }
});
