import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantile } from './plans.mjs';

export function describe(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return { count: finite.length, median: quantile(finite, 0.5), min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null };
}

export function summarizeReport(report, plan) {
  const samples = (report.samples ?? []).filter((sample) => sample.owner === 'group' && sample.succeeded);
  const measured = plan.family === 'input' ? samples.filter((sample) => sample.point === 'diagnostic') : samples;
  const accepted = samples.filter((sample) => sample.point === 'accepted');
  const last = accepted.filter((sample) => sample.n === plan.n);
  const times = measured.map((sample) => sample.checkpointMs).filter(Number.isFinite);
  const storeTimes = measured.map((sample) => sample.storeMs).filter(Number.isFinite);
  const sum = (values) => values.reduce((result, value) => result + value, 0);
  return {
    status: report.status,
    result: report.result,
    error: report.error ?? report.failure ?? null,
    lastCompletedStep: report.lastCompletedStep,
    run: report.timing,
    store: report.stores,
    group: {
      samples: samples.length,
      measuredSamples: measured.length,
      totalCheckpointMs: times.length ? sum(times) : null,
      totalStoreMs: storeTimes.length ? sum(storeTimes) : null,
      checkpoint: describe(times),
      store: describe(storeTimes),
      p95: quantile(times, 0.95),
      lastAccepted: last.map((sample) => ({ checkpointMs: sample.checkpointMs, storeMs: sample.storeMs, n: sample.n, r: sample.r })),
      // Each band has multiple points; exact N only has one observation per process.
      bands: [32, 128, 512, 1000, 2048]
        .map((end, index, ends) => {
          const begin = index ? ends[index - 1] + 1 : 1;
          const rows = accepted.filter((sample) => sample.n >= begin && sample.n <= end && Number.isFinite(sample.checkpointMs));
          const values = rows.map((sample) => sample.checkpointMs);
          return { begin, end, checkpoint: describe(values), p95: quantile(values, 0.95), store: describe(rows.map((sample) => sample.storeMs)) };
        })
        .filter((band) => band.checkpoint.count),
    },
    diagnostic: report.diagnostic,
    storage: report.storage,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = process.argv.slice(2);
  if (!directories.length) throw new Error('Pass one or more experiment directories');
  for (const directory of directories) {
    const base = resolve(directory);
    const summary = JSON.parse(await readFile(join(base, 'summary.json'), 'utf8'));
    const reports = [];
    for (const item of summary.results) {
      if (!item.result) {
        reports.push({ plan: item.plan, status: item.status, error: item.error });
        continue;
      }
      const value = JSON.parse(await readFile(join(base, item.result), 'utf8'));
      reports.push({ plan: value.plan, processUsage: value.processUsage, ...summarizeReport(value.report, value.plan) });
    }
    const byPlan = new Map();
    for (const report of reports) {
      const list = byPlan.get(report.plan.id) ?? [];
      list.push(report);
      byPlan.set(report.plan.id, list);
    }
    const groups = [...byPlan].map(([id, items]) => {
      const complete = items.filter((item) => item.status === 'completed');
      return {
        id,
        plan: items[0].plan,
        statuses: items.map((item) => item.status),
        completed: complete.length,
        // Aggregate process-level statistics, not pooled correlated saves.
        groupSaveMedianMs: describe(complete.map((item) => item.group?.checkpoint.median)),
        groupStoreMedianMs: describe(complete.map((item) => item.group?.store.median)),
        groupSaveTotalMs: describe(complete.map((item) => item.group?.totalCheckpointMs)),
        groupStoreTotalMs: describe(complete.map((item) => item.group?.totalStoreMs)),
        lastAcceptedMs: describe(complete.flatMap((item) => item.group?.lastAccepted.map((row) => row.checkpointMs) ?? [])),
        lastAcceptedStoreMs: describe(complete.flatMap((item) => item.group?.lastAccepted.map((row) => row.storeMs) ?? [])),
        elapsedMs: describe(complete.map((item) => item.run?.elapsedMs)),
        cpuMs: describe(complete.map((item) => item.run?.cpuMs)),
        maxRssKiB: describe(complete.map((item) => item.processUsage?.maxRssKiB)),
      };
    });
    await writeFile(join(base, 'analysis.json'), JSON.stringify({ formatVersion: 1, mode: summary.mode, groups, reports }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ directory: base, groups: groups.map((item) => ({ id: item.id, status: item.statuses, checkpointMs: item.groupSaveMedianMs.median, storeMs: item.groupStoreMedianMs.median, lastMs: item.lastAcceptedMs.median, runMs: item.elapsedMs.median })) }, null, 2));
  }
}
