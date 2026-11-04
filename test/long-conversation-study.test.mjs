import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scenario } from '../examples/long-conversation/scenario.mjs';
import { createFixtureModel } from '../examples/long-conversation/model.mjs';
import { runStudy, validateScenario } from '../examples/long-conversation/study.mjs';
import { ConversationStore } from '@capix/conversation-service/persistence';

test('54 submissions have valid historical references and distinct stable memory topics', () => {
  validateScenario(scenario);
  assert.ok(new Set(scenario.turns.map((turn) => turn.topic)).size >= 6);
  const invalid = structuredClone(scenario);
  invalid.turns[0].expectations[0].sourceTurns = [2];
  assert.throws(() => validateScenario(invalid));
});

test('24-submission study uses the real persistent assembly and keeps evaluation criteria out of model requests', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-long-study-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modified = structuredClone(scenario);
  for (const turn of modified.turns) turn.expectations = [{ claim: 'HIDDEN_RUBRIC_NOT_FOR_MODEL', sourceTurns: [1] }];
  const fixture = createFixtureModel(modified.turns);
  let requests = 0;
  const provider = {
    complete(request, controls) {
      requests++;
      assert.ok(!JSON.stringify(request).includes('HIDDEN_RUBRIC_NOT_FOR_MODEL'));
      return fixture.complete(request, controls);
    },
  };
  const out = join(directory, 'study');
  const summary = await runStudy({ scenario: modified, provider, mode: 'offline', modelName: 'fixture', out, count: 24 });
  assert.equal(summary.complete, true, JSON.stringify(summary.failure));
  assert.equal(summary.modelCalls, 48);
  assert.equal(requests, 48);
  assert.equal(summary.semanticEvaluation, 'not-applicable');
  const snapshot = summary.snapshots[0].database;
  assert.equal(snapshot.messages.count, 48);
  assert.equal(snapshot.completionInteractions.count, 48);
  assert.equal(snapshot.checkpoints.images.bytes, summary.totalImageBytes);
  const events = (await readFile(join(out, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const submissions = events.filter((row) => row.kind === 'submission');
  assert.equal(submissions.length, 24);
  assert.ok(submissions.every((row) => row.completedOutputs === 1 && row.memoryReception === 'accepted' && row.records.entries > 0));
  assert.ok(submissions.at(-1).requests[0].jsonBytes > submissions[0].requests[0].jsonBytes);
  const store = ConversationStore.open(join(out, 'conversation.sqlite'));
  try {
    const saved = store.load();
    const expected = new Map(
      modified.turns
        .slice(0, 24)
        .flatMap((turn) => turn.memoryUpdates)
        .map((update) => [update.topic, update.content]),
    );
    assert.equal(saved.memories.items.length, expected.size);
    for (const item of saved.memories.items) assert.equal(item.content, expected.get(item.topic));
    assert.equal(saved.transcript.messages.length, 48);
    assert.equal(store.checkpoints.listRoots().length, 24);
    assert.ok(store.checkpoints.listRoots().every((head) => head.delivery?.status === 'succeeded'));
  } finally {
    store.close();
  }
  const review = await readFile(join(out, 'review.md'), 'utf8');
  assert.match(review, /HIDDEN_RUBRIC_NOT_FOR_MODEL/);
  await assert.rejects(runStudy({ scenario, provider, mode: 'offline', modelName: 'fixture', out, count: 24 }), { code: 'EEXIST' });
  assert.equal(requests, 48, 'Refusing existing artifacts must happen before any model call');
});

test('study stops after a provider failure, keeps partial facts and does not retry or leak causes', { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-long-failed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const provider = {
    complete() {
      requests++;
      throw new Error('PRIVATE_CREDENTIAL', { cause: { Authorization: 'PRIVATE_CREDENTIAL' } });
    },
  };
  const out = join(directory, 'study');
  const summary = await runStudy({ scenario, provider, mode: 'offline', modelName: 'fixture', out, count: 24 });
  assert.equal(summary.complete, false);
  assert.equal(requests, 1);
  assert.equal(summary.snapshots[0].database.messages.count, 1);
  assert.equal((await readFile(join(out, 'events.jsonl'), 'utf8')).includes('PRIVATE_CREDENTIAL'), false);
});
