import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import * as structures from '@weiliang0121/capix-structure';
import { Scene, Group, Node, checkpointPoint, childReference, reception } from '@weiliang0121/capix-structure';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Runner, Resources, Scene as RuntimeScene, Group as RuntimeGroup, Node as RuntimeNode } from '@weiliang0121/capix-runtime';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

test('structure authors can configure a complete tree without loading or executing a runtime', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { Scene, Group, Node, defineNode } from '@weiliang0121/capix-structure';
    let calls = 0;
    const leaf = defineNode()({ run: () => ++calls });
    const group = new Group().add({ leaf });
    group.run = work => work.children.leaf.invoke(work.input);
    const scene = new Scene().add({ group });
    scene.run = work => work.children.group.invoke(work.input);
    assert.ok(leaf instanceof Node);
    assert.equal(scene.names.group, group);
    assert.equal(group.members[0], leaf);
    assert.equal(calls, 0);
    assert.throws(() => new Group().add(leaf), /parent/);
    assert.throws(() => group.add(group), /Cyclic/);
  `,
    ],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  for (const name of ['Runner', 'Resources', 'Invocation', 'CallableBuilder', 'MemoryCheckpointStore', 'Recorder', 'Transcript']) assert.equal(name in structures, false, `${name} is not a structural author contract`);
});

test('standalone structures and runtime exports share identities and run the dictionary through nested groups', async () => {
  assert.equal(Scene, RuntimeScene);
  assert.equal(Group, RuntimeGroup);
  assert.equal(Node, RuntimeNode);
  const dictionary = new ResourceOffer({ methods: { translate: (origin, word) => origin.get(word) ?? word } });
  const translate = new Node({ deps: { dictionary: dictionary.request() }, run: (work) => work.resources.dictionary.translate(work.input) });
  const group = new Group().add({ translate });
  group.run = (work) => work.children.translate.invoke(work.input);
  const scene = new Scene().add({ group });
  scene.run = (work) => work.children.group.invoke(work.input);
  const greeting = { text: '你好' };
  const resources = new Resources().register(new Resource(new Map([['hello', greeting]])), dictionary);
  const runner = new Runner(scene, resources).build();
  assert.equal(runner.scene, scene);
  assert.equal(scene.names.group, group);
  assert.equal(group.names.translate, translate);
  const translated = await runner.run('hello');
  assert.deepEqual(translated, greeting);
  assert.notEqual(translated, greeting, 'resource aliases do not escape as mutable call facts');
  greeting.text = 'changed source';
  assert.equal(translated.text, '你好');
  assert.equal(Object.isFrozen(translated), true);
  assert.equal(await runner.run('untranslated'), 'untranslated');
});

test('runtime build failure leaves package structures configurable and success locks the same objects', async () => {
  const offer = new ResourceOffer({ methods: { read: (origin) => origin } });
  const leaf = new Node({ deps: { value: offer.request() }, run: () => 'before repair' });
  const scene = new Scene().add({ leaf });
  scene.run = (work) => work.children.leaf.invoke(work.input);
  const resources = new Resources();
  const runner = new Runner(scene, resources);
  assert.throws(() => runner.build(), /Missing|not supplied|provider|supply/i);
  leaf.run = (work) => work.resources.value.read();
  resources.register(new Resource('repaired'), offer);
  assert.equal(runner.build(), runner);
  assert.equal(await runner.run(null), 'repaired');
  assert.throws(() => {
    leaf.run = () => 'late replacement';
  }, TypeError);
  assert.throws(() => scene.add(new Node({ run: () => 'late member' })), /locked|build/i);
  assert.throws(() => runner.build(), /built/);
});

test('structure checkpoint and reception contracts reconnect to runtime recovery without rerunning a child', async () => {
  const codec = { encode: (value) => value, decode: (value) => value };
  let runs = 0;
  let saved;
  const create = (store) => {
    const leaf = new Node({
      run: (work) => {
        runs++;
        return work.input;
      },
    });
    const accepted = reception(leaf, {
      check(value) {
        assert.equal(typeof value, 'number');
        return value;
      },
      ...codec,
    });
    const point = checkpointPoint()({
      name: 'accepted',
      state: codec,
      references: { child: childReference(leaf) },
      resume: { run: (work, _state, refs) => work.children.facts.accepted(refs.child, accepted) },
    });
    const scene = new Scene({
      checkpoint: { key: 'structure-package.accepted', version: 1, input: codec, output: codec, points: [point], receptions: [accepted] },
      async run(work) {
        const call = work.children.create(leaf, work.input);
        const value = await call.invoke({ reception: accepted, result: { succeeded: (text) => text.length } });
        work.checkpoint({ point, state: null, refs: { child: call.ref } });
        return value;
      },
    }).add({ leaf });
    return new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build();
  };
  class Capture extends MemoryCheckpointStore {
    save(image, revision) {
      saved = image;
      return super.save(image, revision);
    }
  }
  assert.equal(await create(new Capture()).run('hello'), 5);
  const store = new MemoryCheckpointStore();
  store.save(saved, 0);
  assert.equal(await create(store).resume(saved.frame.owner.contextId), 5);
  assert.equal(runs, 1);
});

test('structure declarations have no reverse runtime dependency or private cross-package imports', async () => {
  const root = new URL('../packages/structure/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@weiliang0121/capix-contracts', '@weiliang0121/capix-resources']);
  assert.equal(manifest.peerDependencies?.['@weiliang0121/capix-runtime'], undefined);
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(child);
      else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.js')) {
        const content = await readFile(child, 'utf8');
        assert.doesNotMatch(content, /@weiliang0121\/capix-runtime|(?:\.\.\/)+runtime\/|(?:@capix\/|@weiliang0121\/capix-)[\w-]+\/(?:src|dist)\//, fileURLToPath(child));
      }
    }
  }
  await inspect(new URL('dist/', root));
});

test('standalone structure types preserve named children, resources, output and recovery associations', async () => {
  const entry = fileURLToPath(new URL('./types/structure-package.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: false, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const diagnostics = (text) => {
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile));
    return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
  };
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
  const actual = [...new Set(rejected.map((error) => error.file.getLineAndCharacterOfPosition(error.start).line))];
  assert.deepEqual(actual, expected, format(rejected));
});
