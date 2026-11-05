import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { capacityPlan, validateCase } from './plan.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, users: { type: 'string' }, repeats: { type: 'string', default: '2' }, smoke: { type: 'boolean', default: false }, help: { type: 'boolean' } } });
if (values.help || !values.out) {
  console.log('Usage: node examples/capacity/transport.mjs --out NEW_DIRECTORY [--users 200] [--repeats 2] [--smoke]\nSerial direct/yield comparison of the same SQLite checkpoint burst; loopback model only. Nonzero if any case fails, including the direct baseline.');
  if (!values.help) process.exitCode = 1;
} else {
  const repeats = Number(values.repeats);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new RangeError('Repeats must be within 1..5');
  const users = Number(values.users ?? (values.smoke ? '2' : '200'));
  const workload = capacityPlan({ smoke: values.smoke, users: [users] }).find((entry) => entry.profile === 'checkpoint' && entry.pattern === 'burst');
  const directory = resolve(values.out);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const cases = Array.from({ length: repeats }, (_, index) => ['direct', 'yield'].map((transport) => validateCase({ ...workload, rounds: 2, transport, name: `${transport}-${index + 1}` }))).flat();
  const environment = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cpus: cpus().length, memoryBytes: totalmem(), mode: 'offline-transport-comparison', cases };
  writeFileSync(join(directory, 'environment.json'), JSON.stringify(environment, null, 2), { flag: 'wx', mode: 0o600 });
  const summaries = [];
  for (const config of cases) {
    const target = join(directory, config.name);
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`开始 ${config.name} · ${users} 会话 × 2 次提交`);
    const code = await execute(target);
    const result = JSON.parse(readFileSync(join(target, 'result.json'), 'utf8'));
    const summary = { name: config.name, transport: config.transport, exitCode: code, valid: code === 0 && result.valid, modelRequests: result.models?.requests, modelFailures: result.models?.failed, cpuMs: result.work?.cpuMs, eventLoopMaxMs: result.work?.eventLoopDelayMs?.max, completionP95Ms: result.latencyMs?.successfulCompletion?.p95, reloads: result.persistenceReloads, residual: result.residual, failure: result.failure };
    summaries.push(summary);
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(summaries, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(summary));
  }
  console.log(`比较结果：${join(directory, 'summary.json')}`);
  if (summaries.some((entry) => !entry.valid)) process.exitCode = 1;
}

function execute(directory) {
  return new Promise((resolve, reject) => {
    const log = openSync(join(directory, 'worker.log'), 'wx', 0o600);
    const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(new URL('./worker.mjs', import.meta.url)), directory], { detached: process.platform !== 'win32', stdio: ['ignore', log, log], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG } });
    closeSync(log);
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const timer = setTimeout(kill, 180_000);
    process.once('SIGINT', kill);
    process.once('SIGTERM', kill);
    const cleanup = () => {
      clearTimeout(timer);
      process.off('SIGINT', kill);
      process.off('SIGTERM', kill);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code) => {
      cleanup();
      resolve(code ?? -1);
    });
  });
}
