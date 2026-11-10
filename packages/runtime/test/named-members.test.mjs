import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node, Group, Scene } from '@weiliang0121/capix-structure';
import { Driver } from '@weiliang0121/capix-runtime';
import { reception } from '@weiliang0121/capix-structure';

const binding = { providers: [], source: { capture: () => null } };

test('named registration retains the same structures and invokes through the regular child lifecycle', async () => {
  const primary = new Node({ run: (work) => work.input + 1 });
  const backup = new Node({ run: (work) => String(work.input) });
  const group = new Group();
  const registered = group.add({ primary, backup });
  assert.equal(registered, group);
  assert.deepEqual(group.members, [primary, backup]);
  assert.deepEqual(group.names, { primary, backup });
  Object.assign(group, {
    deps: {},
    run: async (work) => {
      const first = await work.children.primary.invoke(work.input, { result: { succeeded: (value) => value * 2 } });
      return work.children.backup.invoke(first);
    },
  });
  const scene = Object.assign(new Scene().add({ group }), { deps: {}, run: (work) => work.children.group.invoke(work.input) });
  const driver = new Driver();
  const built = driver.build(scene, binding);
  assert.equal(await driver.run(built, 2, {}), '6');
  assert.equal(built, scene);
  assert.ok(Object.isFrozen(group.names));
  assert.throws(() => group.add({ extra: new Node({ run: () => 0 }) }), /locked/);
  assert.throws(() => Object.defineProperty(group, 'names', { value: {} }), TypeError);
});

test('named ports expose the registered members without a duplicate ordinary phase grant', async () => {
  const primary = new Node({ run: () => 1 });
  const backup = new Node({ run: () => 2 });
  const group = new Group().add({ primary, backup });
  group.run = async (work) => (await work.children.primary.invoke(null)) + (await work.children.backup.invoke(null));
  const driver = new Driver();
  assert.equal(await driver.run(driver.build(group, binding), null, {}), 3);
});

test('names are captured from data properties and cannot change during registration or build', async () => {
  const primary = new Node({ run: () => 1 });
  const group = new Group();
  const named = { primary };
  group.add(named);
  named.primary = new Node({ run: () => 99 });
  let getterCalled = false;
  assert.throws(
    () =>
      group.add({
        get reenter() {
          getterCalled = true;
          return primary;
        },
      }),
    /data properties/,
  );
  assert.equal(getterCalled, false);
  assert.throws(() => group.add(new Proxy({ other: primary }, {})), /Named members/);
  Object.assign(group, { deps: {}, run: (work) => work.children.primary.invoke(null) });
  const driver = new Driver();
  assert.equal(await driver.run(driver.build(group, binding), null, {}), 1);
});

test('named invocation validates registered reception values without changing the child output contract', async () => {
  const text = new Node({ run: () => 'value' });
  let checked;
  const accepted = reception(text, {
    check(value) {
      if (typeof value !== 'number') throw new TypeError('numeric reception required');
      checked = value;
      return value;
    },
    encode: (value) => value,
    decode: (value) => value,
  });
  const group = new Group().add({ text });
  group.checkpoint = { key: 'named-reception', version: 1, input: { encode: (value) => value, decode: (value) => value }, output: { encode: (value) => value, decode: (value) => value }, points: [], receptions: [accepted] };
  Object.assign(group, { deps: {}, run: (work) => work.children.text.invoke(null, { reception: accepted, result: { succeeded: (value) => value.length } }) });
  const driver = new Driver();
  assert.equal(await driver.run(driver.build(group, binding), null, {}), 5);
  assert.equal(checked, 5);

  const invalid = new Node({ run: () => 'raw' });
  const numeric = reception(invalid, {
    check(value) {
      if (typeof value !== 'number') throw new TypeError('numeric reception required');
      return value;
    },
    encode: (value) => value,
    decode: (value) => value,
  });
  const parent = new Group().add({ invalid });
  parent.checkpoint = { key: 'invalid-named', version: 1, input: { encode: (value) => value, decode: (value) => value }, output: { encode: (value) => value, decode: (value) => value }, points: [], receptions: [numeric] };
  Object.assign(parent, { deps: {}, run: (work) => work.children.invalid.invoke(null, { reception: numeric, result: { succeeded: () => 'wrong' } }) });
  await assert.rejects(driver.run(driver.build(parent, binding), null, {}));
});
