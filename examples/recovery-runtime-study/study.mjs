import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, cuts, launch, modes } from './harness.mjs';

const destination = resolve(process.argv[2] ?? '.capix/recovery-runtime-study');
mkdirSync(destination); // Refuse to combine a new run with existing databases.
const results = [];
function metrics(report) {
  return {
    nodeBody: count(report, 'node-body'),
    resourceBody: count(report, 'resource-body'),
    resourceCleanup: count(report, 'resource-cleanup'),
    materialRead: count(report, 'material-read'),
    capture: count(report, 'capture'),
    coordinatorBody: count(report, 'coordinator-body'),
    mapping: count(report, 'mapping'),
    entityCommits: count(report, 'entity-commit'),
    previews: report.events.filter((event) => event.kind === 'output' && event.value.kind === 'delta').length,
    businessCalled: count(report, 'business-call'),
    businessObserved: count(report, 'business-observed'),
    expiredEndpoints: count(report, 'stale-endpoint-rejected'),
  };
}
function keep(mode, scenario, before, result) {
  results.push({ mode, scenario, status: result.status, metrics: metrics(result), ...(before ? { before } : {}), result });
}
for (const mode of modes) {
  const normal = launch('run', join(destination, `${mode}-normal`), mode);
  assert.equal(normal.status, 'succeeded');
  keep(mode, 'normal', null, normal);
  const unknownDirectory = join(destination, `${mode}-missing-child-cp`);
  const unknownCut = launch('run', unknownDirectory, mode, { cut: 'group-waiting' });
  const unknown = launch('resume', unknownDirectory, mode);
  assert.equal(unknown.status, 'failed');
  assert.equal(count(unknown, 'node-body'), 0);
  keep(mode, 'missing-child-cp', unknownCut, unknown);
  for (const cut of cuts) {
    const directory = join(destination, `${mode}-${cut}`);
    const interrupted = launch('run', directory, mode, { cut });
    const result = launch('resume', directory, mode);
    assert.notEqual(interrupted.pid, result.pid);
    assert.equal(result.status, ['preview-pending', 'preview-emitted'].includes(cut) ? 'failed' : 'succeeded');
    assert.equal(count(result, 'entity-commit'), 1);
    assert.equal(count(result, 'resource-body'), 1);
    keep(mode, cut, interrupted, result);
  }
  for (const fault of ['resource-close', 'child-finish-ack', 'strict-observation', 'cancel-after-preview']) {
    const result = launch('run', join(destination, `${mode}-${fault}`), mode, { fault });
    assert.equal(result.status, 'failed');
    assert.equal(count(result, 'fallback'), 0);
    keep(mode, fault, null, result);
  }
  const strictDirectory = join(destination, `${mode}-strict-recovery`);
  const strictCut = launch('run', strictDirectory, mode, { cut: 'child-finish' });
  const strict = launch('resume', strictDirectory, mode, { fault: 'strict-checkpoint' });
  assert.equal(strict.status, 'failed');
  assert.equal(strict.error.code, 'OBSERVATION_FAILED');
  keep(mode, 'strict-recovery', strictCut, strict);
  const driftDirectory = join(destination, `${mode}-material-change`);
  const driftCut = launch('run', driftDirectory, mode, { cut: 'child-finish' });
  const drift = launch('resume', driftDirectory, mode, { source: { revision: 2, text: 'changed material' } });
  assert.equal(drift.status, 'succeeded');
  assert.equal(drift.result.text, 'one: original material');
  keep(mode, 'material-change', driftCut, drift);
  const doubleDirectory = join(destination, `${mode}-double-cut`);
  launch('run', doubleDirectory, mode, { cut: 'entity-applied' });
  const secondCut = launch('resume', doubleDirectory, mode, { cut: 'group-accepted' });
  const resumed = launch('resume', doubleDirectory, mode);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(count(resumed, 'mapping'), 2);
  assert.equal(count(resumed, 'entity-commit'), 1);
  keep(mode, 'double-cut', secondCut, resumed);
}

function observe(mode, path, policy) {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./observation-process.mjs', import.meta.url)), mode, path, policy], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(child.error);
  assert.equal(child.status, mode === 'cut' ? 73 : 0, child.stderr);
  return JSON.parse(child.stdout);
}
const observation = [];
const normalObservation = observe('run', join(destination, 'normal-observation.sqlite'), 'business');
assert.equal(normalObservation.status, 'failed');
observation.push({ scenario: 'normal-required-business', result: normalObservation });
for (const policy of ['business', 'resource']) {
  const path = join(destination, `recovered-${policy}.sqlite`);
  const before = observe('cut', path, policy);
  const result = observe('resume', path, policy);
  assert.equal(result.status, policy === 'business' ? 'succeeded' : 'failed');
  observation.push({ scenario: `recovered-required-${policy}`, knownGap: policy === 'business', before, result });
}

const repository = fileURLToPath(new URL('../../', import.meta.url));
const experiment = fileURLToPath(new URL('.', import.meta.url));
const names = ['scenario.mjs', 'process.mjs', 'store.mjs', 'harness.mjs', 'recovery.test.mjs', 'observation-process.mjs', 'observation.test.mjs', 'study.mjs'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(names.map((name) => [name, hash(readFileSync(join(experiment, name)))]));
const report = {
  format: 'capix-recovery-runtime-study@1',
  generatedAt: new Date().toISOString(),
  node: process.version,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  trackedWorkingDiffDigest: hash(execFileSync('git', ['diff', '--no-ext-diff'], { cwd: repository })),
  scope: 'real Frame v5 and Runner.resume; author-side coordinator reentry; no production host qualification or performance claim',
  sources,
  results,
  observation,
};
writeFileSync(join(destination, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ destination, scenarios: results.length, observationCases: observation.length, knownGap: 'new business observation has no recovery outlet', results: results.map(({ mode, scenario, status, metrics }) => ({ mode, scenario, status, ...metrics })) }, null, 2));
