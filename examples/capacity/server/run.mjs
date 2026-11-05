import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cpus, totalmem, platform, arch } from 'node:os';
import { measureProcess } from '../measurement.mjs';
import { startUpstream } from '../upstream-client.mjs';
import { startHost } from './host.mjs';
import { runLoad } from './load.mjs';
import { serverCapacityPlan } from './plan.mjs';
import { renderServerReport } from './report.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, workers: { type: 'string' }, rates: { type: 'string' }, users: { type: 'string' }, duration: { type: 'string' }, history: { type: 'string' }, output: { type: 'string' }, smoke: { type: 'boolean', default: false }, help: { type: 'boolean' } } });
if (values.help || !values.out) {
  console.log('Usage: node examples/capacity/server/run.mjs --out NEW_DIRECTORY [--workers 1,2,4] [--rates 10,20,30] [--users 200] [--duration 30] [--history 2048] [--output 2048] [--smoke]\n--rates is submissions/second PER WORKER; each case uses total workers × rate. Separate local HTTP workers and model producer, SQLite + CP, no real credentials.');
  if (!values.help) process.exitCode = 1;
} else {
  const cases = serverCapacityPlan({
    ...(values.smoke ? { workers: [1, 2], perWorkerRates: [4], users: 8, durationSeconds: 2, historyBytes: 256, outputBytes: 256, smoke: true } : {}),
    ...(values.workers ? { workers: values.workers.split(',').map(Number) } : {}),
    ...(values.rates ? { perWorkerRates: values.rates.split(',').map(Number) } : {}),
    ...(values.users ? { users: Number(values.users) } : {}),
    ...(values.duration ? { durationSeconds: Number(values.duration) } : {}),
    ...(values.history ? { historyBytes: Number(values.history) } : {}),
    ...(values.output ? { outputBytes: Number(values.output) } : {}),
  });
  const directory = resolve(values.out);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const environment = { startedAt: new Date().toISOString(), cpu: cpus()[0]?.model, cpus: cpus().length, memoryBytes: totalmem(), platform: platform(), arch: arch(), node: process.version, mode: 'offline-http-multiprocess', cases };
  save(join(directory, 'environment.json'), environment);
  const results = [];
  for (const config of cases) {
    const target = join(directory, config.name);
    mkdirSync(target, { mode: 0o700 });
    save(join(target, 'config.json'), config);
    console.log(`开始 ${config.name} · ${config.users} 会话 · ${config.durationSeconds}s`);
    const result = await runCase(target, config);
    save(join(target, 'result.json'), result);
    results.push(result);
    save(
      join(directory, 'summary.json'),
      results.map(({ load, workers, ...result }) => ({ ...result, load: load && { ...load, rows: undefined }, workers: workers?.map(({ model, sessions, ...worker }) => ({ ...worker, model: { ...model, calls: undefined }, sessions: sessions?.length })) })),
    );
    writeFileSync(join(directory, 'report.md'), renderServerReport(environment, results), { mode: 0o600 });
    console.log(`${result.valid ? '完整负载通过' : '未通过'} ${config.name} · ${result.load?.workload?.succeeded ?? 0}/${result.load?.workload?.offered ?? 0} · 完成p95 ${result.load?.latencyMs?.completion?.p95?.toFixed(1) ?? '—'}ms · 模型失败 ${result.modelFailures ?? '—'}`);
    if (result.failure) break;
  }
  console.log(`报告：${join(directory, 'report.md')}`);
  if (results.some((result) => !result.valid)) process.exitCode = 1;
}

async function runCase(directory, config) {
  const hosts = [];
  let upstream;
  let generator;
  const result = { config, valid: false };
  try {
    upstream = await startUpstream(config.model);
    // Sequential acquisition leaves every successfully started owner reachable
    // for cleanup if a later owner cannot start. Workload begins only after all ready.
    for (let workerIndex = 0; workerIndex < config.workers; workerIndex++) {
      const path = join(directory, `worker-${workerIndex}`);
      mkdirSync(path, { mode: 0o700 });
      hosts.push(await startHost({ directory: path, config, workerIndex, endpoint: upstream.endpoint }));
    }
    const sessions = hosts.flatMap((host) => host.sessions).sort((a, b) => a.index - b.index);
    if (sessions.length !== config.users || new Set(sessions.map((session) => session.index)).size !== config.users) throw new Error('Worker session ownership is incomplete');
    await Promise.all(hosts.map((host) => host.start()));
    generator = measureProcess();
    result.load = await runLoad({ sessions, rate: config.rate, durationSeconds: config.durationSeconds, outputBytes: config.model.outputBytes });
    result.generator = generator.stop();
    generator = undefined;
    result.workers = await Promise.all(hosts.map((host) => host.finish()));
    result.upstream = await upstream.close();
    upstream = undefined;
    assess(result);
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack };
    result.valid = false;
  } finally {
    if (generator) result.generator = generator.stop();
    const closed = await Promise.allSettled(hosts.map((host) => host.stop()));
    if (upstream) closed.push(...(await Promise.allSettled([upstream.close()])));
    const failures = closed.filter((entry) => entry.status === 'rejected');
    if (failures.length) {
      result.valid = false;
      result.cleanupFailures = failures.map((entry) => entry.reason.message);
    }
  }
  return result;
}

function assess(result) {
  const { config, load, workers, upstream } = result;
  const calls = workers.flatMap((worker) => worker.model.calls);
  const sessions = workers.flatMap((worker) => worker.sessions);
  const bySession = new Map(sessions.map((session) => [session.index, session]));
  const exactDeliveries = load.rows
    .filter((row) => row.status === 'succeeded')
    .every((row) => {
      const session = bySession.get(row.session);
      const pair = session?.pairs.find((pair) => pair.nonce === row.submissionId);
      return session?.conversationId === row.conversationId && pair?.inputIndex === row.inputIndex && pair?.answerIndex === row.answerIndex && pair?.turn === JSON.parse(row.query).turn;
    });
  result.modelFailures = calls.filter((call) => call.status !== 'succeeded').length;
  result.workerCpuCores = workers.reduce((sum, worker) => sum + worker.metrics.cpuPercentOfOneCore / 100, 0);
  result.workerPeakRssSum = workers.reduce((sum, worker) => sum + worker.metrics.memory.peakSampled.rss, 0);
  result.maxWorkerEventLoopP99Ms = Math.max(...workers.map((worker) => worker.metrics.eventLoopDelayMs.p99 ?? 0));
  const offered = load.workload.offered;
  result.checks = [
    { name: 'all scheduled submissions succeeded with exact committed previews', pass: load.workload.succeeded === offered && offered === Math.ceil(config.rate * config.durationSeconds) },
    { name: 'complete answer and memory requests without degradation', pass: result.modelFailures === 0 && calls.length === offered * 2 && calls.filter((call) => call.phase === 'answer').length === offered },
    { name: 'independent upstream received and completed all calls', pass: upstream.requests === offered * 2 && upstream.completed === offered * 2 && upstream.failed === 0 && upstream.aborted === 0 && upstream.active === 0 },
    { name: 'all session databases reloaded and formal answer bodies verified', pass: sessions.length === config.users && sessions.every((session) => session.reloadVerified && session.answerIntegrity) },
    { name: 'formal assistant count matches HTTP successes', pass: sessions.reduce((sum, session) => sum + session.assistantMessages, 0) === load.workload.succeeded },
    { name: 'each HTTP success names its exact persisted submission and answer indices', pass: exactDeliveries },
    { name: 'host shutdown completed and external work has exited', pass: workers.every((worker) => worker.model.active === 0) },
  ];
  result.valid = result.checks.every((check) => check.pass);
  result.withinExploratoryLatency = result.valid && load.latencyMs.completion.p95 <= 2000 && load.latencyMs.firstDelta.p95 <= 500 && load.latencyMs.schedulerDelay.p99 <= 50;
}

function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}
