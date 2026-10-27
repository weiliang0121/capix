import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group, Node, Resources, Runner, Scene, checkpointPoint, childReference, reception } from '@capix/server-runtime';
import { resolveDeclaration } from '@capix/server-runtime/construction';
import { Resource, ResourceOffer } from '@capix/resources';

const codec = { encode: structuredClone, decode: structuredClone };

test('resolution snapshots each position before selecting observations and completes the tree before host checks', () => {
  const events = [];
  const leaf = new Node({ name: 'leaf', run: () => 'leaf-original' });
  const group = new Group({ name: 'group', run: () => null }).add(leaf);
  const scene = new Scene({ name: 'scene', run: () => null }).add(group);
  let leafRun = leaf.run;
  for (const structure of [scene, group, leaf]) {
    const run = structure.run;
    Object.defineProperty(structure, 'run', {
      configurable: true,
      get() {
        events.push(`snapshot:${structure.name}`);
        return structure === leaf ? leafRun : run;
      },
    });
  }
  const installation = (name) => ({
    declarations(structure) {
      events.push(`select:${name}:${structure.name}`);
      return [];
    },
    check(structure, parent) {
      events.push(`check:${name}:${structure.name}:${parent?.name ?? 'root'}`);
      if (structure === scene) leafRun = () => 'rewritten-after-snapshot';
    },
  });
  const resolved = resolveDeclaration(scene, { observations: [installation('first'), installation('second')] });
  assert.deepEqual(events, ['snapshot:scene', 'select:first:scene', 'select:second:scene', 'snapshot:group', 'select:first:group', 'select:second:group', 'snapshot:leaf', 'select:first:leaf', 'select:second:leaf', 'check:first:scene:root', 'check:second:scene:root', 'check:first:group:scene', 'check:second:group:scene', 'check:first:leaf:group', 'check:second:leaf:group']);
  assert.equal(resolved.members[0].members[0].declaration.run({}), 'leaf-original');
  assert.equal(resolved.definition, scene);
  assert.equal(resolved.members[0].definition, group);
  assert.equal(resolved.members[0].members[0].definition, leaf);
});

test('invalid checkpoint member authority fails before descendant selection or host checks', () => {
  for (const mode of ['reference', 'resume', 'reception']) {
    const events = [];
    const leaf = new Node({ name: 'leaf', run: () => null });
    const foreign = new Node({ run: () => null });
    const point = checkpointPoint()({ name: 'saved', state: codec, references: mode === 'reference' ? { foreign: childReference(foreign) } : {}, resume: { deps: {}, uses: mode === 'resume' ? [foreign] : [], run: () => null } });
    const group = new Group({ name: 'group', checkpoint: { key: `resolution.${mode}`, version: 1, input: codec, output: codec, points: [point], ...(mode === 'reception' ? { receptions: [reception(foreign, { ...codec, check: (value) => value })] } : {}) }, run: () => null }).add(leaf);
    assert.throws(
      () =>
        resolveDeclaration(group, {
          observations: [
            {
              declarations(structure) {
                events.push(`select:${structure.name}`);
                return [];
              },
              check() {
                events.push('check');
              },
            },
          ],
        }),
      /outside its owner/,
      mode,
    );
    assert.deepEqual(events, ['select:group'], mode);
  }
});

test('nested resource scopes replace only local offers and preserve the captured ancestor supply', async () => {
  let sharedCaptures = 0;
  const scopeCaptures = [];
  const origin = { value: 'shared-1' };
  const shared = new ResourceOffer({
    timing: 'binding',
    capture(source) {
      sharedCaptures++;
      return source.value;
    },
    expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }),
  });
  const local = new ResourceOffer({ expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }) });
  const reader = () => new Node({ deps: { shared: shared.request(), local: local.request() }, run: (work) => [work.resources.shared.read(), work.resources.local.read()] });
  const nested = new Group({
    async run(work) {
      assert.deepEqual(Object.keys(work.resources), []);
      return work.children.reader.invoke(work.input);
    },
  }).add({ reader: reader() });
  const outer = new Group({
    async run(work) {
      assert.deepEqual(Object.keys(work.resources), []);
      return [await work.children.reader.invoke(work.input), await work.children.nested.invoke(work.input)];
    },
  }).add({ reader: reader(), nested });
  const sibling = new Node({ deps: { shared: shared.request() }, run: (work) => work.resources.shared.read() });
  const scene = new Scene({
    async run(work) {
      assert.deepEqual(Object.keys(work.resources), []);
      return [await work.children.outer.invoke(work.input), await work.children.sibling.invoke(null)];
    },
  }).add({ outer, sibling });
  const resources = new Resources();
  resources.register(new Resource(origin), shared);
  resources
    .capture(outer, (input) => {
      scopeCaptures.push(`outer:${input}`);
      return `outer:${input}`;
    })
    .register(local, (snapshot) => snapshot);
  resources
    .capture(nested, (input) => {
      scopeCaptures.push(`nested:${input}`);
      return `nested:${input}`;
    })
    .register(local, (snapshot) => snapshot);
  const runner = new Runner(scene, resources).build();
  assert.equal(sharedCaptures, 0);
  assert.deepEqual(scopeCaptures, []);
  assert.deepEqual(await runner.run('one'), [
    [
      ['shared-1', 'outer:one'],
      ['shared-1', 'nested:one'],
    ],
    'shared-1',
  ]);
  origin.value = 'shared-2';
  assert.deepEqual(await runner.run('two'), [
    [
      ['shared-2', 'outer:two'],
      ['shared-2', 'nested:two'],
    ],
    'shared-2',
  ]);
  assert.equal(sharedCaptures, 2, 'local captures must not re-capture the inherited offer');
  assert.deepEqual(scopeCaptures, ['outer:one', 'nested:one', 'outer:two', 'nested:two']);
});
