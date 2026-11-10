import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, Node } from '@weiliang0121/capix-structure';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Runner, Resources, Scene as RuntimeScene, Group as RuntimeGroup, Node as RuntimeNode } from '@weiliang0121/capix-runtime';
import { checkpointPoint, childReference, reception } from '@weiliang0121/capix-structure';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

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
