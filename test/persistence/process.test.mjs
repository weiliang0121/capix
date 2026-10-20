import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteObserverStore, initializeObserver, observeOverview, ObservationFeed } from '@capix/observer-service';
import { CallableRecord, CallableRecordHelper } from '@capix/server-runtime/recording';
import { validateExecutionRecordSnapshot } from '@capix/protocol';

for (const mode of ['content', 'running', 'finished']) {
  test(`SIGKILL at ${mode} boundary recovers saved facts without restarting work`, { timeout: 20000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-crash-'));
    const path = join(directory, 'observer.sqlite');
    let store;
    let environment;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/crash.mjs', import.meta.url)), mode, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk;
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      environment?.close();
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null, diagnostic);
    assert.equal(signal, 'SIGKILL', diagnostic);
    store = SqliteObserverStore.open(path);
    let modelCalls = 0;
    environment = initializeObserver(
      {
        async invoke() {
          ++modelCalls;
          throw new Error('must not resume');
        },
      },
      [],
      { persistence: store },
    );
    assert.equal(modelCalls, 0);
    assert.equal(environment.driver.isRunning(environment.scene), false);
    if (mode === 'content') {
      assert.equal(environment.transcript.get(0).content, 'durable before memory application');
      assert.equal(environment.transcript.revision, 1);
      return;
    }
    assert.equal(environment.recordingArchives[0].state, 'open');
    const old = environment.book.values().find((record) => record instanceof CallableRecord && record.role === 'conversation-task');
    assert.ok(old);
    assert.equal(old.historical, true);
    const overview = observeOverview(environment);
    assert.equal(overview.executions[0].archive.state, 'open');
    assert.equal(old.status, mode === 'running' ? 'running' : 'succeeded');
    const archive = overview.executions[0].archive;
    const detail = { ...CallableRecordHelper.snapshot(environment.recorder, old.id), archive };
    validateExecutionRecordSnapshot(detail);
    if (mode === 'finished') assert.equal(environment.transcript.get(1).content, 'durable answer');
    const frames = [];
    const feed = new ObservationFeed(environment);
    const close = feed.connect((frame) => frames.push(frame));
    close();
    feed.close();
    const baseline = frames.find((frame) => frame.type === 'baseline');
    assert.ok(baseline);
    assert.ok(!baseline.entries.some((entry) => entry.data.id === old.id), 'old running calls are not active baseline entries');
    assert.ok(
      baseline.overview.executions.some((entry) => entry.id === old.id),
      'old calls remain visible as history',
    );
    assert.equal(modelCalls, 0);
  });
}
