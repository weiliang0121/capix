import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { Group, Node, Scene, checkpointPoint, childReference, childReferences, reception } from '@weiliang0121/capix-structure';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { Measurement } from './measurement.mjs';

const ensureText = (value) => {
  if (typeof value !== 'string') throw new TypeError('Expected text');
};
const ensureInteger = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Expected nonnegative integer');
};
const ensureNull = (value) => {
  if (value !== null) throw new TypeError('Expected null');
};
const ensureState = (value) => {
  if (!value || !Number.isSafeInteger(value.step) || value.step < 0 || !Number.isSafeInteger(value.expectedOrder) || !['dispatch', 'accepted', 'completed', 'diagnostic'].includes(value.phase)) throw new TypeError('Invalid benchmark state');
};

/** Deterministic JSON-safe ASCII. This is fixture data, not randomness or a credential. */
export function material(bytes, pattern = 'seeded', seed = 123456789) {
  ensureInteger(bytes);
  if (pattern === 'repeat') return 'x'.repeat(bytes);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const value = Buffer.allocUnsafe(bytes);
  let state = seed;
  for (let index = 0; index < bytes; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    value[index] = alphabet.charCodeAt(state & 63);
  }
  return value.toString('ascii');
}

function requirePlan(value) {
  const plan = { valueBytes: 64, check: 'local', pattern: 'seeded', diagnosticSaves: 16, ...value };
  if (!['timing', 'diagnostic', 'control'].includes(plan.mode) || !['memory', 'sqlite'].includes(plan.store) || !['growth', 'input'].includes(plan.family) || !['current', 'all', 'incremental'].includes(plan.refs) || !['local', 'full'].includes(plan.check) || !['seeded', 'repeat'].includes(plan.pattern)) throw new TypeError('Unknown benchmark plan');
  for (const key of ['n', 'inputBytes', 'valueBytes', 'diagnosticSaves']) ensureInteger(plan[key]);
  if (plan.n > 4096 || plan.inputBytes > 8 * 1024 * 1024 || plan.valueBytes > 1024 * 1024 || plan.diagnosticSaves < 1 || plan.diagnosticSaves > 256) throw new RangeError('Benchmark configuration exceeds harness bounds');
  return plan;
}

function fixture(plan, measurement, progress) {
  const input = material(plan.inputBytes, plan.pattern);
  const value = material(plan.valueBytes, plan.pattern, 987654321);
  const nodeInput = measurement.codec('node.input', ensureText);
  const nodeOutput = measurement.codec('node.output', ensureText);
  const nodeState = measurement.codec('node.state', ensureText);
  const groupInput = measurement.codec('group.input', ensureText);
  const groupOutput = measurement.codec('group.output', ensureInteger);
  const groupState = measurement.codec('group.state', ensureState);
  const sceneInput = measurement.codec('scene.input', ensureNull);
  const sceneOutput = measurement.codec('scene.output', ensureInteger);
  const sceneState = measurement.codec('scene.state', ensureNull);
  const receiveCodec = measurement.codec('reception.output', ensureText);
  const describeNode = () => ({ phase: 'completed', step: progress.step, n: 0, r: 0, a: 0 });
  const nodeCompleted = checkpointPoint()({ name: 'completed', state: nodeState, references: {}, resume: { run: (_work, saved) => saved } });
  const node = new Node({
    checkpoint: { key: 'benchmark.computation.node', version: 1, input: nodeInput, output: nodeOutput, points: [nodeCompleted] },
    run(original) {
      const work = measurement.work(original, 'node', describeNode);
      work.checkpoint({ point: nodeCompleted, state: value, refs: {} });
      return value;
    },
  });
  const acceptedValue = reception(node, {
    ...receiveCodec,
    check: (output) => {
      if (plan.mode === 'diagnostic') measurement.increment('reception.check');
      ensureText(output);
      return output;
    },
  });
  const refsDefinition = { children: childReferences(node) };
  const check = (state, facts) => {
    if (plan.mode === 'diagnostic') measurement.increment('group.check');
    ensureState(state);
    const last = facts.references.children.at(-1);
    if ((last?.order ?? -1) !== state.expectedOrder) throw new Error('Benchmark reference order differs');
    if (plan.check === 'full') {
      const all = facts.children.values();
      for (const [index, fact] of all.entries()) {
        if (plan.mode === 'diagnostic') measurement.increment('group.historyVisits');
        if (fact.order !== index) throw new Error('Benchmark history order differs');
      }
    }
  };
  const noResume = () => {
    throw new Error('This performance fixture does not claim recovery coverage');
  };
  const points = Object.fromEntries(['dispatch', 'accepted', 'completed', 'diagnostic'].map((name) => [name, checkpointPoint()({ name, state: groupState, references: refsDefinition, check, resume: { run: noResume } })]));
  const group = new Group({ checkpoint: { key: 'benchmark.computation.group', version: 1, input: groupInput, output: groupOutput, receptions: [acceptedValue], points: Object.values(points) } }).add({ node });
  group.run = async (original) => {
    const work = measurement.work(original, 'group', (options) => ({ phase: options.state.phase, step: options.state.step, n: progress.created, r: options.refs.children.length, a: options.state.phase === 'dispatch' ? 1 : 0 }));
    let refs = plan.refs === 'incremental' ? work.checkpoint.select(node) : [];
    for (let step = 0; step < plan.n; step++) {
      progress.step = step;
      progress.phase = 'create';
      const child = work.children.create(node, String(step).padStart(8, '0'));
      progress.created = step + 1;
      if (plan.refs === 'incremental') refs.add(child.ref);
      else refs = plan.refs === 'all' ? [...refs, child.ref] : [child.ref];
      if (plan.family === 'growth') {
        progress.phase = 'dispatch';
        work.checkpoint({ point: points.dispatch, state: { step, expectedOrder: step, phase: 'dispatch' }, refs: { children: refs } });
      }
      progress.phase = 'invoke';
      const accepted = await child.invoke({ reception: acceptedValue, result: { succeeded: (output) => output } });
      if (accepted !== value) throw new Error('Unexpected benchmark child result');
      if (plan.family === 'growth') {
        progress.phase = 'accepted';
        work.checkpoint({ point: points.accepted, state: { step: step + 1, expectedOrder: step, phase: 'accepted' }, refs: { children: refs } });
      }
      progress.lastCompletedStep = step + 1;
    }
    if (plan.family === 'input') {
      progress.phase = 'diagnostic';
      const state = { step: plan.n, expectedOrder: plan.n - 1, phase: 'diagnostic' };
      const savedRefs = { children: refs };
      for (let index = 0; index < plan.diagnosticSaves; index++) work.checkpoint({ point: points.diagnostic, state, refs: savedRefs });
    } else {
      progress.phase = 'completed';
      work.checkpoint({ point: points.completed, state: { step: plan.n, expectedOrder: plan.n - 1, phase: 'completed' }, refs: { children: refs } });
    }
    return plan.n;
  };
  const waiting = checkpointPoint()({ name: 'waiting', state: sceneState, references: { group: childReference(group) }, resume: { uses: [group], run: (work, _state, refs) => work.children.resume(refs.group).invoke() } });
  const scene = new Scene({ checkpoint: { key: 'benchmark.computation.scene', version: 1, input: sceneInput, output: sceneOutput, points: [waiting] } }).add({ group });
  scene.run = (original) => {
    const work = measurement.work(original, 'scene', () => ({ phase: 'waiting', step: 0, n: 1, r: 1, a: 1 }));
    const child = work.children.create(group, input);
    work.checkpoint({ point: waiting, state: null, refs: { group: child.ref } });
    return child.invoke();
  };
  return scene;
}

function errorValue(error) {
  const causes = [];
  let current = error;
  for (let index = 0; current && index < 8; index++) {
    causes.push({ name: current.name, code: current.code, message: current.message });
    current = current.cause;
  }
  return { name: error.name, code: error.code, message: error.message, causes };
}

const fileBytes = (path) => (existsSync(path) ? statSync(path).size : 0);

/** One newly built public Runner and fresh Store. No live model, credentials or prior data. */
export async function runSample(value, { path } = {}) {
  const plan = requirePlan(value);
  if (plan.store === 'sqlite' && (!path || existsSync(path))) throw new Error('SQLite benchmark requires a new database path');
  const measurement = new Measurement(plan.mode);
  const progress = { step: 0, phase: 'setup', created: 0, lastCompletedStep: 0 };
  const openStarted = performance.now();
  const host = plan.store === 'sqlite' ? ConversationStore.open(path) : undefined;
  const actualStore = host?.checkpoints ?? new MemoryCheckpointStore();
  const openMs = performance.now() - openStarted;
  const report = { plan, status: 'failed', result: null, samples: measurement.samples, stores: measurement.stores, timing: { openMs }, lastCompletedStep: 0 };
  try {
    const buildStarted = performance.now();
    const scene = fixture(plan, measurement, progress);
    const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store: measurement.store(actualStore) } }).build();
    report.timing.buildMs = performance.now() - buildStarted;
    const cpuStarted = process.cpuUsage();
    const started = performance.now();
    let failure;
    try {
      report.result = await runner.run(null);
      report.status = 'completed';
    } catch (error) {
      failure = error;
    } finally {
      report.timing.elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStarted);
      report.timing.cpuMs = (cpu.user + cpu.system) / 1000;
      report.timing.processMaxRssKiBBeforeInspection = process.resourceUsage().maxRSS;
      report.timing.heapUsedAfterRun = process.memoryUsage().heapUsed;
      report.lastCompletedStep = progress.lastCompletedStep;
    }
    if (failure) report.error = { ...errorValue(failure), step: progress.step, phase: progress.phase, created: progress.created };
    report.diagnostic = plan.mode === 'diagnostic' ? measurement.summary() : null;
    if (host) report.storageBeforeClose = { databaseBytes: fileBytes(path), walBytes: fileBytes(`${path}-wal`) };
  } finally {
    host?.close();
  }
  if (host) {
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      report.storage = {
        ...reader.prepare('SELECT COUNT(*) AS imageIdentities, COUNT(body) AS retainedBodies, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bodyBytes FROM checkpoint_images').get(),
        ...reader.prepare('SELECT COUNT(*) AS heads, COALESCE(SUM(length(CAST(delivery AS BLOB))),0) AS deliveryBytes FROM checkpoint_heads').get(),
        databaseBytes: fileBytes(path),
        walBytes: fileBytes(`${path}-wal`),
        lifecycle: 'closed-store-readonly-inspection',
      };
    } finally {
      reader.close();
    }
  }
  return report;
}
