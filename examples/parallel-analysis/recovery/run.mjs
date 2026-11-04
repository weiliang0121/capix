import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 2) throw new Error('Usage: node examples/parallel-analysis/recovery/run.mjs (offline only)');
const directory = mkdtempSync(join(tmpdir(), 'capix-parallel-recovery-demo-'));
const host = fileURLToPath(new URL('./host.mjs', import.meta.url));
const reports = [];

function execute(mode, database, variant, fault = 'none') {
  const child = spawnSync(process.execPath, [host, mode, database, variant, fault], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(child.error);
  assert.ok(child.stdout, child.stderr);
  return { status: child.status, report: JSON.parse(child.stdout) };
}

try {
  for (const variant of ['accepted', 'handled']) {
    const database = join(directory, `${variant}.sqlite`);
    const stopped = execute('capture', database, variant);
    assert.equal(stopped.status, 73, JSON.stringify(stopped));
    assert.equal(stopped.report.root.image.frame.children[0].state.reception.kind, variant);
    assert.equal(stopped.report.root.image.frame.children[1].state.kind, 'waiting');
    assert.ok(stopped.report.interaction.feedback);
    for (const fault of ['missing-checkpoint', 'missing-feedback', 'wrong-feedback-request']) {
      const refused = execute('resume', database, variant, fault);
      assert.equal(refused.status, 1, JSON.stringify(refused));
      assert.equal(refused.report.resumeEntered, false);
      assert.deepEqual(refused.report.root, stopped.report.root);
      assert.ok(Object.values(refused.report.counters).every((count) => count === 0));
    }
    const resumed = execute('resume', database, variant);
    assert.equal(resumed.status, 0, JSON.stringify(resumed));
    assert.notEqual(resumed.report.pid, stopped.report.pid);
    assert.deepEqual(resumed.report.counters, { primaryRuns: 0, primaryAccepted: 0, primaryHandled: 0, secondaryAccepted: 1, mergeAccepted: 1, primaryRequests: 0, secondaryRequests: 0, mergeRequests: 1 });
    assert.equal(resumed.report.root.delivery.status, 'succeeded');
    assert.deepEqual(resumed.report.root.image.frame.children[0], stopped.report.root.image.frame.children[0]);
    reports.push({ primary: variant, before: 'A 已接纳/处理；B 等待；B 反馈已保存', after: resumed.report.root.delivery.status, resumedCounters: resumed.report.counters, output: resumed.report.result, refusedWithoutChanges: ['missing-checkpoint', 'missing-feedback', 'wrong-feedback-request'] });
  }
  console.log('离线跨进程并行恢复验证通过：');
  console.log(JSON.stringify(reports, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
