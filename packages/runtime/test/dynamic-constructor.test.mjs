import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dynamic, Node, Group, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner, callableHooks } from '@weiliang0121/capix-runtime';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function install(dynamic, resources = new Resources(), capabilities = {}) {
  const scene = new Scene().add({ dynamic });
  scene.run = (work) => work.children.dynamic.invoke(work.input);
  return new Runner(scene, resources, undefined, capabilities).build();
}

const finish = (value) => ({ kind: 'finish', value });

const call = (option, input) => ({ kind: 'call', option, input });

test('constructor Dynamic composes actual decision/action nodes with isolated per-call resources', async () => {
  const board = new ResourceOffer({
    methods: {
      read: (origin) => origin.value,
      write: (origin, value) => {
        origin.value = value;
      },
    },
  });
  const action = new Node({
    deps: { board: board.request() },
    run: async (work) => {
      await work.resources.board.write(`${work.input}:done`);
      return 1;
    },
  });
  const decision = new Node({
    deps: { board: board.request() },
    run: async (work) => {
      const value = await work.resources.board.read();
      return value === undefined ? call('action', work.input) : finish(value);
    },
  });
  const dynamic = new Dynamic({ options: { action }, decide: decision });
  assert.ok(dynamic instanceof Group);
  assert.deepEqual(dynamic.members, [action, decision]);
  assert.deepEqual(dynamic.names, {}, 'candidate names belong to the decision contract, not named Work ports');
  const resources = new Resources();
  resources.capture(dynamic, () => ({ value: undefined })).register(board, (value) => value);
  const calls = [];
  const runner = install(dynamic, resources, {
    hooks: [action, decision].map((node) =>
      callableHooks(node, {
        started: () => (_context, invocation) => {
          calls.push(invocation.context.id);
        },
      }),
    ),
  });
  assert.equal(await runner.run('one'), 'one:done');
  assert.equal(await runner.run('two'), 'two:done');
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);
});

test('constructor Dynamic snapshots all candidate data properties and the progression bound', async () => {
  let actions = 0;
  const action = new Node({
    run: () => {
      actions++;
    },
  });
  const candidateConfig = Object.defineProperty({}, 'hidden', { value: action, configurable: true });
  const config = { options: candidateConfig, decide: new Node({ run: () => (actions ? finish('done') : call('hidden', null)) }), maxSteps: 1 };
  const dynamic = new Dynamic(config);
  Object.defineProperty(candidateConfig, 'hidden', { value: new Node({ run: () => assert.fail('replacement must not run') }) });
  config.maxSteps = 0;
  config.decide = new Node({ run: () => assert.fail('replacement decision must not run') });
  assert.equal(dynamic.maxSteps, 1);
  assert.throws(() => {
    dynamic.maxSteps = 2;
  }, TypeError);
  assert.throws(() => {
    dynamic.run = () => 'replacement';
  }, TypeError);
  assert.equal(await install(dynamic).run(null), 'done');
  assert.equal(actions, 1);
  assert.equal(dynamic.options, undefined);
  assert.equal(dynamic.decide, undefined);
  assert.equal(dynamic.decisions, undefined);
});

test('bounded Dynamic permits at most N actions and one final finish decision', async () => {
  let actions = 0;
  let decisions = 0;
  const action = new Node({ run: () => ++actions });
  const decision = new Node({
    run: () => {
      decisions++;
      return actions === 2 ? finish('done') : call('action', null);
    },
  });
  assert.equal(await install(new Dynamic({ options: { action }, decide: decision, maxSteps: 2 })).run(null), 'done');
  assert.equal(actions, 2);
  assert.equal(decisions, 3);
  let overflowActions = 0;
  const forever = new Dynamic({ options: { action: new Node({ run: () => ++overflowActions }) }, decide: new Node({ run: () => call('action', null) }), maxSteps: 2 });
  await assert.rejects(install(forever).run(null), /exceeded 2 action steps/);
  assert.equal(overflowActions, 2);
  assert.equal(await install(new Dynamic({ options: {}, decide: new Node({ run: () => finish(undefined) }), maxSteps: 0 })).run(null), undefined);
});

for (const invalid of [null, [], { kind: 'unknown' }, { kind: 'finish' }, { kind: 'call', option: 'action' }, call('missing', null), call('decision', null)]) {
  test(`constructor Dynamic rejects invalid selection ${JSON.stringify(invalid)} before actions`, async () => {
    let actions = 0;
    const dynamic = new Dynamic({ options: { action: new Node({ run: () => ++actions }) }, decide: new Node({ run: () => invalid }) });
    await assert.rejects(install(dynamic).run(null), /Dynamic decision|not registered/);
    assert.equal(actions, 0);
  });
}

test('constructor Dynamic leaves business failure propagation and cancellation to ordinary calls', async () => {
  let decisions = 0;
  const error = new Error('failed');
  const action = new Node({
    run: () => {
      throw error;
    },
  });
  const decision = new Node({
    run: () => {
      decisions++;
      return call('action', null);
    },
  });
  await assert.rejects(install(new Dynamic({ options: { action }, decide: decision })).run(null), (failure) => failure === error);
  assert.equal(decisions, 1);
  const controller = new AbortController();
  let resolve;
  const entered = new Promise((accept) => {
    resolve = accept;
  });
  let release;
  const waiting = new Promise((accept) => {
    release = accept;
  });
  let cancelledDecisions = 0;
  const dynamic = new Dynamic({
    options: {
      wait: new Node({
        run: async () => {
          resolve();
          await waiting;
        },
      }),
    },
    decide: new Node({
      run: () => {
        cancelledDecisions++;
        return call('wait', null);
      },
    }),
  });
  const rejected = assert.rejects(install(dynamic).run(null, { signal: controller.signal }), { code: 'INVOCATION_CANCELLED' });
  await entered;
  controller.abort();
  release();
  await rejected;
  assert.equal(cancelledDecisions, 1);
});

test('constructor Dynamic types infer complete signatures and reject invalid decisions', async () => {
  const entry = fileURLToPath(new URL('./types/dynamic-constructor.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: false, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  function diagnostics(text) {
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, create) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : getSourceFile(file, languageVersion, onError, create));
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
