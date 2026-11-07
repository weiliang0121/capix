import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { benchmarkPlans } from './plans.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, suite: { type: 'string', default: 'first' }, mode: { type: 'string', default: 'timing' }, repeat: { type: 'string', default: '3' }, case: { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node examples/checkpoint-computation/run.mjs --out NEW_DIRECTORY [--suite first|extended|supplement|overhead|migration|selection|all] [--mode timing|diagnostic|control] [--repeat 3] [--case ID] [--timeout SECONDS]');
  process.exit(0);
}
if (!values.out || !['timing', 'diagnostic', 'control'].includes(values.mode)) throw new Error('A new --out directory and a valid mode are required');
const repeats = Number(values.repeat);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('--repeat must be 1..10');
const requestedTimeout = values.timeout === undefined ? undefined : Number(values.timeout);
if (requestedTimeout !== undefined && (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > 300)) throw new Error('--timeout must be within 0..300 seconds');
const allPlans = benchmarkPlans(values.suite);
const plans = values.case ? allPlans.filter((plan) => plan.id === values.case) : allPlans;
if (!plans.length) throw new Error('Unknown case');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(values.out);
await mkdir(output, { recursive: false });
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const excluded = new Set(['node_modules', '.git', '.capix']);
async function hashTree(directory, files = []) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await hashTree(path, files);
    else if (entry.isFile()) files.push({ path: relative(root, path), sha256: digest(await readFile(path)) });
  }
  return files;
}
const sourceTrees = ['contracts', 'protocol', 'server', 'services/conversation', 'examples/checkpoint-computation'];
const files = [];
for (const path of sourceTrees) await hashTree(join(root, path), files);
for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) files.push({ path, sha256: digest(await readFile(join(root, path))) });
const probe = new DatabaseSync(':memory:');
const sqliteVersion = probe.prepare('SELECT sqlite_version() AS version').get().version;
probe.close();
const order = [];
for (let repeat = 1; repeat <= repeats; repeat++) for (const plan of repeat % 2 ? plans : [...plans].reverse()) order.push({ ...plan, repeat, mode: values.mode });
const dirty = git('status', '--short');
await writeFile(join(output, 'manifest.json'), JSON.stringify({ formatVersion: 1, createdAt: new Date().toISOString(), baseline: git('rev-parse', 'HEAD').trim(), dirty, diffSha256: digest(git('diff', '--binary')), node: process.version, v8: process.versions.v8, sqliteVersion, platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalRamBytes: os.totalmem(), execArgv: process.execArgv, suite: values.suite, mode: values.mode, repeats, order, planSha256: digest(JSON.stringify(order)), sourceAndBuildFiles: files, note: 'No environment variables, credentials, username or hostname recorded. One independent process and new stores per sample; results include existing uncommitted cache changes identified by file hashes. Cases run sequentially.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

const results = [];
const refused = new Map();
for (const [index, plan] of order.entries()) {
  const name = plan.id + '-r' + plan.repeat;
  if (refused.has(plan.id)) {
    results.push({ name, plan, status: 'not-run', reason: 'Earlier independent attempt reached a boundary', earlier: refused.get(plan.id) });
    continue;
  }
  const directory = join(output, name);
  await mkdir(directory);
  const planPath = join(directory, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan) + '\n', { flag: 'wx', mode: 0o600 });
  const timeoutMs = (requestedTimeout ?? (plan.n > 512 ? 300 : 120)) * 1000;
  console.log('[' + (index + 1) + '/' + order.length + '] ' + name + ' ' + plan.mode);
  const started = performance.now();
  const execution = await new Promise((resolveExecution) => {
    const child = spawn(process.execPath, [worker, planPath, directory], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let outputBytes = 0;
    let stderr = '';
    let terminated;
    let spawnError;
    const timer = setTimeout(() => {
      terminated = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 16 * 1024 * 1024) {
        terminated = 'output-limit';
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (stderr.length < 65536) stderr += chunk.toString().slice(0, 65536 - stderr.length);
      if (outputBytes > 16 * 1024 * 1024) {
        terminated = 'output-limit';
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => {
      spawnError = error.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveExecution({ code, signal, terminated, spawnError, stderr, processElapsedMs: performance.now() - started });
    });
  });
  let parsed;
  try {
    const bytes = await readFile(join(directory, 'result.json'));
    if (bytes.length > 16 * 1024 * 1024) throw new Error('Report exceeds 16 MiB');
    parsed = JSON.parse(bytes);
  } catch (error) {
    if (!execution.terminated) execution.reportError = 'Worker did not produce a valid report: ' + error.message;
  }
  if (parsed && (!['completed', 'failed'].includes(parsed.report?.status) || JSON.stringify(parsed.plan) !== JSON.stringify(plan))) execution.reportError = 'Worker report does not match the requested plan';
  if (parsed?.report.status === 'completed' && (execution.code !== 0 || parsed.report.result !== plan.n)) execution.reportError = 'Completed worker has an invalid exit status or result';
  const status = execution.terminated ?? (parsed?.report.status === 'completed' && execution.code === 0 ? 'completed' : 'failed');
  const item = { name, plan, status, result: parsed ? relative(output, join(directory, 'result.json')) : null, execution, error: parsed?.report.error ?? null };
  results.push(item);
  if (status !== 'completed') refused.set(plan.id, name);
  await writeFile(join(output, 'summary.json'), JSON.stringify({ formatVersion: 1, mode: values.mode, results }, null, 2) + '\n', { mode: 0o600 });
  console.log('  ' + status + ' process=' + (execution.processElapsedMs / 1000).toFixed(2) + 's' + (parsed?.report.error ? ' ' + JSON.stringify(parsed.report.error) : ''));
  if (execution.spawnError || execution.reportError) throw new Error(execution.spawnError ?? execution.reportError);
}
await writeFile(join(output, 'summary.json'), JSON.stringify({ formatVersion: 1, mode: values.mode, results }, null, 2) + '\n', { mode: 0o600 });
console.log('Report: ' + join(output, 'summary.json'));
