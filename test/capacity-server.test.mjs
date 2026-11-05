import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { serverCapacityPlan } from '../examples/capacity/server/plan.mjs';

const executable = fileURLToPath(new URL('../examples/capacity/server/run.mjs', import.meta.url));

function experiment(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-http-capacity-'));
  const children = new Set();
  const kill = (child) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  t.after(() => {
    for (const child of children) kill(child);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    async run(args, expectedCode = 0) {
      const out = join(directory, 'experiment');
      const child = spawn(process.execPath, [executable, '--out', out, ...args], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG } });
      children.add(child);
      let output = '';
      let expired = false;
      const collect = (bytes) => {
        output = (output + bytes.toString()).slice(-24000);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        expired = true;
        kill(child);
      }, 45000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.equal(expired, false, output);
        assert.equal(code, expectedCode, output);
        const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
        return summary.map(({ config }) => JSON.parse(readFileSync(join(out, config.name, 'result.json'), 'utf8')));
      } finally {
        clearTimeout(timer);
        // Reap the whole isolated process group, including an accidentally orphaned
        // model/worker, before deleting the experiment's private databases.
        kill(child);
        children.delete(child);
      }
    },
  };
}

test('HTTP capacity smoke uses complete public Web hosts and independently validates persistence and model calls', { timeout: 60000 }, async (t) => {
  const fixture = experiment(t);
  const cases = await fixture.run(['--smoke']);
  assert.deepEqual(
    cases.map((entry) => entry.config.workers),
    [1, 2],
  );
  for (const result of cases) {
    assert.equal(result.valid, true, JSON.stringify(result.failure ?? result.checks));
    assert.equal(result.load.workload.succeeded, result.config.rate * result.config.durationSeconds);
    assert.equal(result.load.workload.rejected, 0);
    assert.equal(result.load.workload.failed, 0);
    assert.equal(result.load.rows.length, result.load.workload.offered);
    assert.equal(result.workers.length, result.config.workers);
    assert.equal(new Set(result.workers.map((worker) => worker.pid)).size, result.config.workers);
    assert.ok(result.workers.every((worker) => Number.isSafeInteger(worker.pid) && worker.pid > 0 && worker.pid !== process.pid));
    assert.equal(result.modelFailures, 0);
    assert.equal(result.upstream.requests, result.load.workload.offered * 2);
    assert.equal(result.upstream.completed, result.upstream.requests);
    assert.equal(result.upstream.active, 0);
    assert.ok(result.load.wire.frames > result.load.workload.offered);
    assert.ok(result.load.wire.responseBytes > 0);
    assert.equal(result.load.latencyMs.firstDelta.count, result.load.workload.offered);
    assert.equal(
      result.load.buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
      result.load.workload.offered,
    );
    assert.equal(result.load.buckets.at(-1).inFlightAtEnd, 0);
    const sessions = result.workers.flatMap((worker) => worker.sessions);
    assert.equal(sessions.length, result.config.users);
    assert.equal(new Set(sessions.map((session) => session.index)).size, result.config.users);
    const bySession = new Map(sessions.map((session) => [session.index, session]));
    for (const row of result.load.rows) {
      assert.equal(row.status, 'succeeded');
      assert.equal(row.correctPreview, true);
      assert.equal(row.committed, true);
      assert.ok(row.firstDeltaMs >= 0);
      assert.ok(row.scheduledCompletionMs >= row.completionMs);
      const session = bySession.get(row.session);
      assert.equal(session.conversationId, row.conversationId);
      assert.deepEqual(
        session.pairs.find((pair) => pair.nonce === row.submissionId),
        { inputIndex: row.inputIndex, answerIndex: row.answerIndex, nonce: row.submissionId, turn: JSON.parse(row.query).turn },
      );
    }
    for (const session of sessions) {
      assert.equal(session.reloadVerified, true);
      assert.equal(session.answerIntegrity, true, JSON.stringify(session.errors));
      assert.equal(session.viewMembers, session.messages + 1);
      assert.equal(session.memories, 1);
    }
    for (const worker of result.workers) {
      assert.equal(worker.model.active, 0);
      assert.ok(worker.metrics.cpuMs > 0);
      assert.ok(worker.metrics.memory.peakSampled.rss > 0);
      assert.equal(worker.storage.walBytes, 0);
      assert.equal(worker.storage.shmBytes, 0);
      assert.equal(worker.storage.databases, worker.sessions.length);
      assert.ok(worker.storage.tables.checkpoint_images > 0);
      assert.equal(worker.storage.tables.completion_interactions, worker.model.calls.length);
    }
  }
});

test('HTTP open-loop overload exposes busy rejections and never reports degraded capacity as passing', { timeout: 60000 }, async (t) => {
  const fixture = experiment(t);
  const [result] = await fixture.run(['--smoke', '--workers', '1', '--users', '1', '--rates', '20', '--duration', '1'], 1);
  assert.equal(result.valid, false);
  assert.equal(result.failure, undefined, 'A measured overload is a complete experiment, not a broken harness');
  assert.equal(result.load.workload.offered, 20);
  assert.ok(result.load.workload.rejected > 0);
  assert.ok(result.load.workload.succeeded > 0);
  assert.equal(result.load.workload.failed, 0);
  assert.equal(result.load.workload.succeeded + result.load.workload.rejected, 20);
  assert.equal(result.load.latencyMs.firstDelta.count, result.load.workload.succeeded);
  assert.ok(result.load.rows.filter((row) => row.status === 'rejected').every((row) => row.firstDeltaMs === null));
  assert.equal(result.upstream.requests, result.load.workload.succeeded * 2);
  assert.equal(result.upstream.completed, result.upstream.requests);
  assert.equal(result.upstream.active, 0);
  assert.equal(result.workers[0].sessions[0].assistantMessages, result.load.workload.succeeded);
  assert.equal(result.workers[0].sessions[0].answerIntegrity, true);
});

test('HTTP capacity plans enforce bounded workload, unique worker counts and enough private sessions', () => {
  const plan = serverCapacityPlan();
  assert.equal(plan.length, 9);
  assert.deepEqual(
    plan.filter((entry) => entry.workers === 4).map((entry) => entry.rate),
    [40, 80, 120],
  );
  for (const options of [{ workers: [] }, { workers: [1, 1] }, { workers: [9] }, { workers: [4], users: 3 }, { users: 501 }, { perWorkerRates: [] }, { perWorkerRates: [0] }, { perWorkerRates: [101] }, { durationSeconds: 301 }, { workers: [8], perWorkerRates: [100], durationSeconds: 30 }, { historyBytes: 65537 }, { outputBytes: 127 }, { profile: 'memory' }]) assert.throws(() => serverCapacityPlan(options), RangeError);
});
