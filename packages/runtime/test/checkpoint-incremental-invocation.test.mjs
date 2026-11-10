import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Scene, Node, Runner, Resources, checkpointPoint, childReference, reception } from '@weiliang0121/capix-runtime';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

const identity = { encode: (value) => value, decode: (value) => value };

test('real hot saves publish fixed child fields once, while each point check still runs', async () => {
  const counters = {};
  const codec = (name) =>
    Object.fromEntries(
      ['encode', 'decode'].map((method) => [
        method,
        (value) => {
          const key = `${name}.${method}`;
          counters[key] = (counters[key] ?? 0) + 1;
          return value;
        },
      ]),
    );
  const candidate = { text: 'first', nested: { score: 1 } };
  const node = new Node({ checkpoint: { key: 'fixed-child', version: 1, input: codec('child-input'), output: codec('child-output'), points: [] }, run: () => candidate });
  const accepted = reception(node, {
    ...codec('accepted'),
    check() {
      counters.reception = (counters.reception ?? 0) + 1;
    },
  });
  let escaped;
  let extracted;
  let first;
  let second;
  const point = checkpointPoint()({
    name: 'saved',
    state: identity,
    references: { child: childReference(node) },
    check(_state, facts) {
      counters.check = (counters.check ?? 0) + 1;
      escaped = facts;
      extracted = facts.references.child;
      assert.equal(extracted.reception.value.text, 'accepted');
    },
    resume: { run: () => 1 },
  });
  const store = new MemoryCheckpointStore();
  const writes = [];
  const port = {
    read: (id) => store.read(id),
    save(commit, revision) {
      // The port receives a fixed request; it cannot rewrite what the later
      // acknowledgement is checked against by mutating its argument in place.
      for (const metadata of [commit, commit.contract, commit.frame, commit.frame.owner, commit.frame.input, commit.frame.currentInput, commit.state, commit.references]) {
        assert.ok(Object.isFrozen(metadata));
        assert.throws(() => {
          metadata.unexpected = true;
        }, TypeError);
      }
      writes.push(commit);
      return store.save(commit, revision);
    },
    finish: (...args) => store.finish(...args),
  };
  const scene = new Scene({ checkpoint: { key: 'fixed-parent', version: 1, input: codec('parent-input'), output: identity, receptions: [accepted], points: [point] } }).add({ node });
  scene.run = async (work) => {
    const call = work.children.create(node, { request: 'fixed' });
    await call.invoke({ reception: accepted, result: { succeeded: (value) => ({ text: 'accepted', child: value }) } });
    work.checkpoint({ point, state: 1, refs: { child: call.ref } });
    first = { ...counters };
    candidate.nested.score = 99;
    work.checkpoint({ point, state: 2, refs: { child: call.ref } });
    second = { ...counters };
    assert.equal(work.children.facts.get(call.ref).returned.output.nested.score, 1);
    return 1;
  };
  await new Runner(scene, new Resources(), undefined, { checkpoints: { store: port } }).build().run({ material: 'fixed' });
  for (const name of ['parent-input', 'child-input', 'child-output', 'accepted']) for (const method of ['encode', 'decode']) assert.equal(second[`${name}.${method}`], first[`${name}.${method}`], `${name}.${method} must not revisit old facts`);
  assert.equal(second.reception, first.reception);
  assert.equal(second.check, first.check + 1);
  assert.equal(writes[1].children.length, 0);
  assert.equal(writes[1].values.length, 2, 'only current state and full author refs are submitted');
  assert.equal(extracted.returned.output.nested.score, 1);
  assert.throws(() => escaped.children.values(), /synchronous checkpoint check/);
  assert.throws(() => escaped.children.list(node), /synchronous checkpoint check/);
  assert.throws(() => escaped.references.child, /synchronous checkpoint check/);
});

test('uncontracted stable data keeps undefined, missing fields and negative zero across cold recovery', async () => {
  const body = { missing: undefined, negative: -0, nested: [undefined, '~u', null] };
  let saved;
  const node = new Node({ run: () => body });
  const point = checkpointPoint()({
    name: 'saved',
    state: identity,
    references: { child: childReference(node) },
    check(_state, facts) {
      assert.deepEqual(facts.references.child.returned.output, body);
    },
    resume: { run: (_work, _state, _refs) => 1 },
  });
  const scene = new Scene({ checkpoint: { key: 'lossless-parent', version: 1, input: identity, output: identity, points: [point] } }).add({ node });
  scene.run = async (work) => {
    const call = work.children.create(node, null);
    await call.invoke();
    work.checkpoint({ point, state: null, refs: { child: call.ref } });
    return 1;
  };
  const store = new MemoryCheckpointStore();
  const port = {
    read: (id) => store.read(id),
    save(commit, revision) {
      const receipt = store.save(commit, revision);
      saved = store.read(receipt.contextId).image;
      return receipt;
    },
    finish: (...args) => store.finish(...args),
  };
  await new Runner(scene, new Resources(), undefined, { checkpoints: { store: port } }).build().run(null);
  const next = new MemoryCheckpointStore();
  next.save(saved, 0);
  const resumedNode = new Node({ run: () => assert.fail('child must not rerun') });
  const resumedPoint = checkpointPoint()({
    name: 'saved',
    state: identity,
    references: { child: childReference(resumedNode) },
    check(_state, facts) {
      const value = facts.references.child.returned.output;
      assert.deepEqual(value, body);
      assert.ok(Object.hasOwn(value, 'missing'));
      assert.ok(Object.is(value.negative, -0));
    },
    resume: { run: () => 1 },
  });
  const resumed = new Scene({ checkpoint: { key: 'lossless-parent', version: 1, input: identity, output: identity, points: [resumedPoint] }, run: () => assert.fail('root must not rerun') }).add({ node: resumedNode });
  assert.equal(await new Runner(resumed, new Resources(), undefined, { checkpoints: { store: next } }).build().resume(saved.frame.owner.contextId), 1);
});
