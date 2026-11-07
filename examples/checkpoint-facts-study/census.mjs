// Reproducible migration census. Does not alter source/dist, assertions, or persisted contracts.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hook = fileURLToPath(new URL('./migration-hooks.mjs', import.meta.url));
const [mode, target] = process.argv.slice(2);
if (!['--run', '--summarize'].includes(mode) || !target) throw new Error('Usage: node examples/checkpoint-facts-study/census.mjs --run|--summarize OUTPUT_DIRECTORY');
const directory = resolve(target);

async function command(program, args, log, env = process.env) {
  const output = createWriteStream(join(directory, log), { flags: 'wx' });
  const child = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const result = await new Promise((done, fail) => {
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal }));
  });
  await new Promise((done) => output.end(done));
  return result;
}

if (mode === '--run') {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error('Census output directory must be empty');
  const build = await command('pnpm', ['build'], 'build.log');
  if (build.code) throw new Error('Build failed; inspect build.log');
  const baseline = await command('pnpm', ['test:unit'], 'baseline.tap');
  if (baseline.code) throw new Error('Baseline failed; do not attribute existing failures to migration');
  const automatic = join(directory, 'automatic');
  await mkdir(automatic);
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${JSON.stringify(hook)}`].filter(Boolean).join(' ');
  const migrated = await command(process.execPath, ['--test', 'test/**/*.test.mjs'], 'automatic.tap', { ...process.env, NODE_OPTIONS: nodeOptions, CAPIX_STABLE_STUDY_DIR: automatic });
  const focused = await command(process.execPath, ['--test', 'examples/checkpoint-facts-study/migration.test.mjs'], 'migration.tap');
  const entities = await command(process.execPath, ['--test', 'examples/checkpoint-facts-study/migration.test.mjs'], 'entities.tap', { ...process.env, CAPIX_STABLE_STUDY_ENTITIES: '1' });
  await writeFile(join(directory, 'commands.json'), JSON.stringify({ node: process.version, build, baseline, migrated, focused, entities }, null, 2));
}

function parseTap(body) {
  const totals = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'duration_ms']) {
    const matches = [...body.matchAll(new RegExp(`^# ${key} ([\\d.]+)$`, 'gm'))];
    if (matches.length) totals[key] = Number(matches.at(-1)[1]);
  }
  const failures = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok \d+ - /.test(lines[i])) continue;
    const end = lines.findIndex((line, j) => j > i && /^\s*\.\.\.$/.test(line));
    failures.push({ title: lines[i].trim(), diagnostic: lines.slice(i + 1, end < 0 ? i + 20 : end).join('\n') });
  }
  return { totals, failures };
}

const summary = { generatedAt: new Date().toISOString(), node: process.version, tests: {}, instrumentation: { processes: 0, boundaries: {}, modules: [], rejected: {} } };
for (const name of ['baseline', 'automatic', 'migration', 'entities']) {
  try {
    summary.tests[name] = parseTap(await readFile(join(directory, `${name}.tap`), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const modules = new Set();
for (const name of await readdir(join(directory, 'automatic'))) {
  if (!/^process-\d+\.json$/.test(name)) continue;
  const data = JSON.parse(await readFile(join(directory, 'automatic', name), 'utf8'));
  summary.instrumentation.processes++;
  for (const [boundary, count] of Object.entries(data.boundaries)) summary.instrumentation.boundaries[boundary] = (summary.instrumentation.boundaries[boundary] ?? 0) + count;
  for (const path of data.modules) modules.add(path);
  for (const rejection of data.rejected) {
    const key = `${rejection.boundary}: ${rejection.reason ?? rejection.message}`;
    summary.instrumentation.rejected[key] = (summary.instrumentation.rejected[key] ?? 0) + 1;
  }
}
summary.instrumentation.modules = [...modules].sort();
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ tests: Object.fromEntries(Object.entries(summary.tests).map(([name, value]) => [name, value.totals])), instrumentation: summary.instrumentation }, null, 2));
