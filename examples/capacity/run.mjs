import { parseArgs } from 'node:util';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus, totalmem, platform, arch } from 'node:os';
import { capacityPlan } from './plan.mjs';
import { renderReport } from './report.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, smoke: { type: 'boolean', default: false }, users: { type: 'string' }, duration: { type: 'string' }, rate: { type: 'string' }, transport: { type: 'string', default: 'yield' }, help: { type: 'boolean', default: false } } });
if (values.help || !values.out) {
  console.log('Usage: node examples/capacity/run.mjs --out NEW_DIRECTORY [--smoke] [--users 10,50,100,200] [--duration 60] [--rate 20] [--transport yield|direct]\n只运行本地可控模型，无真实模型或凭证。默认阶梯并发、四组装配对照、两组60秒持续负载和取消/解除订阅。--out 必须是新目录；保留结果和独立实验数据库，不覆盖旧数据。');
  if (!values.help) process.exitCode = 1;
} else {
  const cases = capacityPlan({ smoke: values.smoke, transport: values.transport, ...(values.users ? { users: values.users.split(',').map(Number) } : {}), ...(values.duration ? { durationSeconds: Number(values.duration) } : {}), ...(values.rate ? { rate: Number(values.rate) } : {}) });
  const directory = resolve(values.out);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const environment = { startedAt: new Date().toISOString(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpus: cpus().length, memoryBytes: totalmem(), node: process.version, explicitGc: true, mode: 'offline', cases };
  writeFileSync(join(directory, 'environment.json'), JSON.stringify(environment, null, 2), { flag: 'wx', mode: 0o600 });
  const results = [];
  for (const config of cases) {
    const target = join(directory, config.name);
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`开始 ${config.name}`);
    const code = await execute(target, config);
    let result;
    let delivered = false;
    try {
      result = JSON.parse(readFileSync(join(target, 'result.json'), 'utf8'));
      delivered = true;
    } catch {
      result = { config, valid: false, failure: { message: `worker exit ${code}; see worker.log` } };
    }
    if (code !== 0) result.valid = false;
    results.push(result);
    writeFileSync(join(directory, 'report.md'), renderReport(environment, results), { mode: 0o600 });
    writeFileSync(
      join(directory, 'summary.json'),
      JSON.stringify(
        results.map(({ rows, modelCalls, content, ...summary }) => summary),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`${result.valid ? '通过' : '失败'} ${config.name} · ${result.workload?.succeeded ?? 0}/${result.workload?.offered ?? 0} 成功 · 完成p95 ${result.latencyMs?.successfulCompletion?.p95?.toFixed(1) ?? '—'} ms`);
    if (!delivered) {
      console.log('工作进程异常退出，停止后续负载；已保留部分报告与日志。');
      break;
    }
  }
  console.log(`报告：${join(directory, 'report.md')}`);
  if (results.some((result) => !result.valid)) process.exitCode = 1;
}

function execute(directory, config) {
  return new Promise((resolve, reject) => {
    const log = openSync(join(directory, 'worker.log'), 'wx', 0o600);
    const worker = spawn(process.execPath, ['--expose-gc', fileURLToPath(new URL('./worker.mjs', import.meta.url)), directory], { stdio: ['ignore', log, log], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG } });
    closeSync(log);
    const timeout = setTimeout(() => worker.kill('SIGTERM'), (config.pattern === 'steady' ? config.durationSeconds * 1000 : 0) + 180_000);
    const interrupt = () => worker.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const cleanup = () => {
      clearTimeout(timeout);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    };
    worker.once('error', (error) => {
      cleanup();
      reject(error);
    });
    worker.once('exit', (code) => {
      cleanup();
      resolve(code ?? -1);
    });
  });
}
