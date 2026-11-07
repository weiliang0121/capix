import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runSample } from './fixture.mjs';

const [planPath, directory] = process.argv.slice(2);
if (!planPath || !directory) throw new Error('worker requires PLAN_JSON and NEW_SAMPLE_DIRECTORY');
const plan = JSON.parse(await readFile(planPath, 'utf8'));
// Fresh structures and stores for warmup; only code/JIT can be reused.
const warmupPlan = { ...plan, family: 'growth', mode: 'control', n: 8, inputBytes: 1024, valueBytes: 64, check: 'local', pattern: 'seeded' };
const warmup = await runSample(warmupPlan, { path: join(directory, 'warmup.sqlite') });
if (warmup.status !== 'completed') throw new Error('Warmup failed: ' + JSON.stringify(warmup.error));
const report = await runSample(plan, { path: join(directory, 'sample.sqlite') });
await writeFile(join(directory, 'result.json'), JSON.stringify({ formatVersion: 1, plan, warmup: { status: warmup.status, n: 8 }, report, processUsage: { maxRssKiB: process.resourceUsage().maxRSS, note: 'Whole process high-water mark, includes imports, warmup and final reporting.' } }) + '\n', { flag: 'wx', mode: 0o600 });
if (report.status !== 'completed') process.exitCode = 2;
