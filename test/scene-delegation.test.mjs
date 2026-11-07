import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Scene, Group, Node, Sequence, Dynamic, checkpointPoint } from '@capix/structure';
import { Resource, ResourceOffer } from '@capix/resources';
import { Resources, Runner, callableHooks, defineObservation } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';

const build = (scene, resources = new Resources(), capabilities = {}) => new Runner(scene, resources, undefined, capabilities).build();
const codec = { encode: (value) => value, decode: (value) => value };

test('Scene(child) registers and invokes the same member, preserving stable final data and ordinary reception', async () => {
  const child = new Node({ run: (work) => work.input });
  const scene = new Scene(child);
  const calls = new Map();
  const hooks = [scene, child].map((structure) =>
    callableHooks(structure, {
      started: () => (_context, invocation) => {
        calls.set(structure, invocation);
      },
    }),
  );
  const runner = build(scene, new Resources(), { hooks });
  const input = { text: 'hello' };
  const result = await runner.run(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(scene.members, [child]);
  assert.deepEqual(scene.names, {});
  assert.equal(scene.kind, 'scene');
  assert.notEqual(calls.get(scene).context.id, calls.get(child).context.id);
  const relation = calls.get(scene).children.get(calls.get(child));
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'accepted');
  assert.equal(relation.reception.output, result);
  input.text = 'changed outside';
  assert.equal(result.text, 'hello');
  const firstCall = calls.get(child).context.id;
  assert.deepEqual(await runner.run(input), input);
  assert.notEqual(calls.get(child).context.id, firstCall);
});

test('later add keeps the selected delegate and build-time configuration may explicitly replace run', async () => {
  let selected = 0;
  let optional = 0;
  const child = new Node({ run: () => ++selected });
  const other = new Node({ run: () => ++optional });
  const scene = new Scene(child).add({ other });
  assert.equal(await build(scene).run(null), 1);
  assert.equal(optional, 0);
  assert.deepEqual(scene.members, [child, other]);

  const alternate = new Node({ run: (work) => `other:${work.input}` });
  const replaced = new Scene(new Node({ run: () => assert.fail('replaced delegate must not run') })).add({ alternate });
  replaced.run = (work) => work.children.alternate.invoke(work.input);
  assert.equal(await build(replaced).run('input'), 'other:input');
  assert.throws(() => {
    replaced.run = () => 'late';
  }, TypeError);
});

test('configuration constructors and Group/Sequence/Dynamic delegates remain ordinary Scenes', async () => {
  const configuration = {
    factor: 2,
    run(work) {
      return this.factor * work.input;
    },
  };
  assert.equal(await build(new Scene(configuration)).run(3), 6);
  const empty = new Scene();
  empty.run = (work) => work.input;
  assert.equal(await build(empty).run(4), 4);
  assert.equal(await build(new Scene(new Group({ run: (work) => work.input + 1 }))).run(5), 6);
  const sequence = new Sequence([new Node({ run: (work) => work.input + 1 }), new Node({ run: (work) => work.input * 2 })]);
  assert.equal(await build(new Scene(sequence)).run(3), 8);
  const dynamic = new Dynamic({ options: {}, decide: new Node({ run: (work) => ({ kind: 'finish', value: work.input.length }) }) });
  assert.equal(await build(new Scene(dynamic)).run('hello'), 5);
});

test('Scene delegation preserves single ownership and rejects fake or invalid members', () => {
  const child = new Node({ run: () => null });
  const owner = new Scene(child);
  assert.throws(() => new Scene(child), /parent/);
  assert.deepEqual(owner.members, [child]);
  assert.throws(() => new Scene(new Scene()), /Group or Node/);
  assert.throws(() => new Scene({ kind: 'node', run: () => null }), /Unsupported.*kind/);
  assert.throws(() => new Scene(new Proxy(new Node(), {})), /proxies/);
});

test('Scene does not inherit child resource, delta, or checkpoint declarations', async () => {
  const dictionary = new ResourceOffer({ methods: { read: (origin, input) => origin.get(input) } });
  const point = checkpointPoint()({ name: 'complete', state: codec, references: {}, resume: { run: (_work, state) => state } });
  const child = new Node({
    deps: { dictionary: dictionary.request() },
    output: { result: String, delta: String },
    checkpoint: { key: 'test.scene-delegation.child', version: 1, input: codec, output: codec, points: [point] },
    async run(work) {
      const value = await work.resources.dictionary.read(work.input);
      work.output.emit('preview');
      work.checkpoint({ point, state: value, refs: {} });
      return value;
    },
  });
  const scene = new Scene(child);
  assert.equal(scene.deps, undefined);
  assert.equal(scene.output, undefined);
  assert.equal(scene.checkpoint, undefined);
  const resources = new Resources();
  resources.register(new Resource(new Map([['hello', '你好']])), dictionary);
  const store = new MemoryCheckpointStore();
  const saved = [];
  const events = [];
  const runner = build(scene, resources, { checkpoints: { store, observation: { observe: (fact) => saved.push(fact) } } });
  assert.equal(
    await runner.run('hello', {
      output: {
        receive(event) {
          events.push(event);
        },
      },
    }),
    '你好',
  );
  assert.equal(
    events.some((event) => event.kind === 'delta'),
    false,
  );
  const checkpoint = saved.find((fact) => fact.kind === 'saved');
  assert.ok(checkpoint, 'the child retains its own checkpoint mechanism');
  assert.equal(store.read(checkpoint.contextId).delivery.status, 'succeeded');
});

test('delegation leaves failure and cancellation with the ordinary child mechanism', async () => {
  const failure = new Error('business failed');
  let runs = 0;
  const failed = new Scene(
    new Node({
      run() {
        runs++;
        throw failure;
      },
    }),
  );
  await assert.rejects(build(failed).run(null), (error) => error === failure);
  assert.equal(runs, 1);
  const controller = new AbortController();
  let entered;
  let release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const scene = new Scene(
    new Node({
      async run() {
        entered();
        await waiting;
        return 'late';
      },
    }),
  );
  const runner = build(scene);
  const rejected = assert.rejects(runner.run(null, { signal: controller.signal }), { code: 'INVOCATION_CANCELLED' });
  await started;
  controller.abort();
  release();
  await rejected;
  assert.equal(runner.isRunning, false);
});

test('delegation still exposes ordinary parent/child observation and cannot hide strict failures', async () => {
  const child = new Node({ run: (work) => work.input });
  const scene = new Scene(child);
  const seen = [];
  const observer = defineObservation({
    deps: {},
    observe(fact) {
      seen.push(fact.kind);
    },
  });
  const declarations = () => [observer];
  assert.equal(await build(scene, new Resources(), { observations: [{ bindInvocation: () => ({ observe() {} }), declarations }] }).run('value'), 'value');
  assert.equal(seen.filter((kind) => kind === 'started').length, 2);
  assert.equal(seen.filter((kind) => kind === 'finished').length, 2);
  const brokenChild = new Node({ run: () => 'result' });
  const brokenScene = new Scene(brokenChild);
  const strict = defineObservation(
    {
      deps: {},
      observe(fact) {
        if (fact.kind === 'finished') throw new Error('observer failed');
      },
    },
    { failure: 'propagate' },
  );
  const runner = build(brokenScene, new Resources(), { observations: [{ bindInvocation: () => ({ observe() {} }), declarations: (structure) => (structure === brokenChild ? [strict] : []) }] });
  await assert.rejects(runner.run(null), { code: 'OBSERVATION_FAILED' });
});

test('delegating Scene constructor infers signatures and rejects incompatible inputs', async () => {
  const entry = fileURLToPath(new URL('./types/scene-delegation.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: false, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  function diagnostics(text) {
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, version, onError, create) => (file === entry ? ts.createSourceFile(file, text, version, true) : getSourceFile(file, version, onError, create));
    return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
  }
  const format = (errors) => ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
  const accepted = diagnostics(source);
  assert.equal(accepted.length, 0, format(accepted));
  const lines = source.split('\n');
  const expected = lines.flatMap((line, index) => (line.includes('@ts-expect-error') ? [index + 1] : []));
  const rejected = diagnostics(lines.map((line) => (line.includes('@ts-expect-error') ? '' : line)).join('\n'));
  assert.ok(
    rejected.every((error) => error.file?.fileName === entry),
    format(rejected),
  );
  assert.deepEqual([...new Set(rejected.map((error) => error.file.getLineAndCharacterOfPosition(error.start).line))], expected, format(rejected));
});
