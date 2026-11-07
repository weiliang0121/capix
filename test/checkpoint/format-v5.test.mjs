import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { cloneCheckpointImage, cloneCheckpointHead, checkpointReference, checkpointReferenceChild, MemoryCheckpointStore } from '@capix/checkpoint';

function image() {
  const child = { identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, round: 1, order: 0, input: { request: 'initial' }, state: { kind: 'returned', output: 'delivered', progress: { round: 2, currentInput: { request: 'child-second' }, phase: 'receive' }, reception: { kind: 'accepted', output: { selected: true } } } };
  return { id: 'point-image', formatVersion: 5, contract: { key: 'parent-contract', version: 1 }, point: 'saved', frame: { owner: { contextId: 'parent', kind: 'group' }, round: 1, phase: 'execute', input: {}, currentInput: {}, nextChildOrder: 1, children: [child] }, state: { selected: true }, references: { chosen: checkpointReference(child), all: [checkpointReference(child)], repeated: checkpointReference(child) } };
}
const copy = (value) => JSON.parse(JSON.stringify(value));

function handledReception() {
  const value = image();
  const child = value.frame.children[0];
  child.state.reception = { kind: 'failed', error: { code: 'REJECTED', message: 'parent rejected output' }, failure: { kind: 'exception', contextId: 'parent', phase: 'execute', contract: 'parent/rejected' } };
  value.frame.round = 2;
  value.frame.currentInput = { second: true };
  value.frame.continuation = { fromRound: 1, stage: 'handling', reason: 'use another candidate', origin: { kind: 'child-reception', child: checkpointReference(child) } };
  return value;
}

test('production v5 image preserves complete relations, child progress and repeated reference slots', () => {
  const value = image();
  const fixed = cloneCheckpointImage(value);
  assert.equal(fixed.formatVersion, 5);
  assert.equal(fixed.frame.children.length, 1);
  assert.equal(fixed.frame.children[0].state.progress.round, 2);
  assert.equal(fixed.frame.children[0].round, 1);
  assert.equal(checkpointReferenceChild(fixed.references.chosen, fixed.frame.children), fixed.frame.children[0]);
  assert.equal(checkpointReferenceChild(fixed.references.repeated, fixed.frame.children), fixed.frame.children[0]);
  value.frame.children[0].state.output = 'mutated';
  assert.equal(fixed.frame.children[0].state.output, 'delivered');
  assert.equal(Object.isFrozen(fixed.references.all), true);
});

test('production v5 survives a separate process without memory objects', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import {readFileSync} from 'node:fs'; import { cloneCheckpointImage } from '@capix/checkpoint'; const value=cloneCheckpointImage(JSON.parse(readFileSync(0,'utf8'))); process.stdout.write(JSON.stringify({version:value.formatVersion,position:value.frame.children[0].target.position,ref:value.references.chosen.contextId}));"], { cwd: process.cwd(), input: JSON.stringify(image()), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { version: 5, position: 0, ref: 'child' });
});

test('production rejects v1/v2/v3/v4 and malformed persistent identity without upgrading', () => {
  for (const formatVersion of [1, 2, 3, 4]) {
    const prior = { ...image(), formatVersion };
    assert.throws(() => cloneCheckpointImage(prior), /formatVersion 5/);
  }
  const mutations = [
    (value) => {
      delete value.references;
    },
    (value) => {
      delete value.frame.children[0].target;
    },
    (value) => {
      value.frame.children[0].target.position = -1;
    },
    (value) => {
      value.references.chosen.contextId = 'other';
    },
    (value) => {
      value.references.chosen.parentContextId = 'other';
    },
    (value) => {
      value.references.chosen.parentRound = 2;
    },
    (value) => {
      value.references.chosen.order = 100;
    },
    (value) => {
      value.references.chosen.target.position = 1;
    },
  ];
  for (const mutate of mutations) {
    const value = copy(image());
    mutate(value);
    assert.throws(() => cloneCheckpointImage(value), /Invalid checkpoint/);
  }
});

test('production continuation is an accepted second-round fact with an accurate failure origin', () => {
  const value = handledReception();
  const restored = cloneCheckpointImage(value);
  assert.equal(restored.frame.children[0].state.output, 'delivered');
  assert.equal(restored.frame.children[0].state.reception.kind, 'failed');
  assert.equal(restored.frame.children[0].state.reception.error instanceof Error, false);
  assert.equal(Object.isFrozen(restored.frame.children[0].state.reception.error), true);
  const mutations = [
    (copy) => {
      copy.frame.round = 1;
    },
    (copy) => {
      delete copy.frame.continuation;
    },
    (copy) => {
      copy.frame.continuation.origin.kind = 'child-return';
    },
    (copy) => {
      copy.frame.continuation.origin.child.order = 1;
    },
    (copy) => {
      copy.frame.continuation.stage = 'accept';
    },
    (copy) => {
      copy.frame.children[0].state.reception.failure.kind = 'error';
    },
    (copy) => {
      copy.frame.children[0].state.reception.failure.contextId = 'child';
    },
    (copy) => {
      copy.frame.children[0].state.reception.failure.phase = 'handling';
    },
  ];
  for (const mutate of mutations) {
    const invalid = copy(value);
    mutate(invalid);
    assert.throws(() => cloneCheckpointImage(invalid), /Invalid checkpoint/);
  }
});

test('a different failed reception is not made handled by another continuation source', () => {
  const value = handledReception();
  const other = copy(value.frame.children[0]);
  other.identity.contextId = 'other-child';
  other.order = 1;
  value.frame.children.push(other);
  value.frame.nextChildOrder = 2;
  assert.throws(() => cloneCheckpointImage(value), /not the accepted continuation origin/);
});

test('complete unselected acceptance values remain strict and state cannot hide live data', () => {
  const value = image();
  value.references = {};
  value.frame.children[0].state.reception.output = new Date();
  assert.throws(() => cloneCheckpointImage(value), /live objects/);
  const withoutOutput = image();
  delete withoutOutput.frame.children[0].state.reception.output;
  assert.doesNotThrow(() => cloneCheckpointImage(withoutOutput));
});

test('waiting needs a CP contract while successful delivery without one remains valid', () => {
  assert.doesNotThrow(() => cloneCheckpointImage(image()));
  const value = image();
  value.frame.children[0].state = { kind: 'waiting' };
  assert.throws(() => cloneCheckpointImage(value), /resumable contract/);
  value.frame.children[0].contract = { key: 'child-contract', version: 1 };
  assert.doesNotThrow(() => cloneCheckpointImage(value));
});

test('v5 memory store and head validation retain independent image and final delivery budgets', () => {
  const value = image();
  value.state.padding = 'x'.repeat(5 * 1024 * 1024);
  const store = new MemoryCheckpointStore();
  const saved = store.save(value, 0);
  const completed = store.finish('parent', saved.revision, { status: 'succeeded', output: 'y'.repeat(5 * 1024 * 1024), progress: { round: 1, currentInput: {}, phase: 'receive' } });
  assert.doesNotThrow(() => cloneCheckpointHead(store.read('parent')));
  assert.throws(() => store.save({ ...value, id: 'another' }, completed.revision), { code: 'CHECKPOINT_CONFLICT' });
});

test('real Invocation captures in one process and resumes successful no-CP child acceptance in another', () => {
  const worker = new URL('./fixtures/v5-call.mjs', import.meta.url);
  const first = spawnSync(process.execPath, [worker.pathname, 'capture'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const saved = JSON.parse(first.stdout);
  assert.equal(saved.image.formatVersion, 6);
  assert.equal(saved.delivery, undefined);
  assert.equal(saved.image.frame.children[0].contract, undefined);
  assert.equal(saved.image.frame.children[0].state.reception.kind, 'pending');
  const second = spawnSync(process.execPath, [worker.pathname, 'restore'], { cwd: process.cwd(), input: first.stdout, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const completed = JSON.parse(second.stdout);
  assert.equal(completed.restored, true);
  assert.equal(completed.result, 'external result:accepted');
  assert.equal(completed.head.delivery.status, 'succeeded');
  assert.equal(completed.head.image.frame.children[0].state.reception.kind, 'accepted');
  assert.equal(completed.head.image.frame.children[0].state.reception.output, completed.result);
});

test('production codecs decode complete historical IO into stable data with explicit domain wire encoding', async () => {
  const { decodeCheckpointFrame, checkCheckpointReferences } = await import('@capix/server-runtime/construction');
  // Domain behavior stays outside the formal value; the codec returns plain data.
  const render = (value) => `domain:${value.text}`;
  const codec = {
    encode(value) {
      assert.equal(typeof value?.text, 'string');
      return { tag: 'domain', text: value.text };
    },
    decode(value) {
      if (value?.tag !== 'domain' || typeof value.text !== 'string') throw new Error('invalid domain wire value');
      return { text: value.text };
    },
  };
  const wire = (text) => codec.encode({ text });
  const binding = { key: 'domain-parent', version: 1, input: codec, output: codec };
  const childBinding = { key: 'domain-child', version: 1, input: codec, output: codec };
  const value = image();
  value.contract = { key: binding.key, version: binding.version };
  value.frame.input = wire('parent-initial');
  value.frame.currentInput = wire('parent-current');
  const first = value.frame.children[0];
  first.contract = { key: childBinding.key, version: childBinding.version };
  first.input = wire('first-initial');
  first.state.progress.currentInput = wire('first-current');
  first.state.output = wire('first-output');
  const second = copy(first);
  second.identity.contextId = 'unselected';
  second.order = 1;
  second.input = wire('second-initial');
  second.state.progress.currentInput = wire('second-current');
  second.state.output = wire('second-output');
  value.frame.children.push(second);
  value.frame.nextChildOrder = 2;
  const saved = cloneCheckpointImage(value);
  const layout = [{ kind: 'node', binding: childBinding }];
  const decoded = decodeCheckpointFrame(saved.frame, binding, layout);
  assert.equal(render(decoded.input), 'domain:parent-initial');
  assert.equal(render(decoded.currentInput), 'domain:parent-current');
  for (const child of decoded.children) {
    assert.equal(typeof child.input.text, 'string');
    assert.equal(typeof child.state.progress.currentInput.text, 'string');
    assert.equal(typeof child.state.output.text, 'string');
    assert.equal(Object.isFrozen(child.state.output), true, 'decoded formal values use the same stable boundary as live delivery');
  }
  assert.equal(saved.frame.children[1].state.output.tag, 'domain');
  assert.equal(render(decoded.children[1].state.output), 'domain:second-output');
  const slots = { chosen: { cardinality: 'one', position: 0 }, all: { cardinality: 'many', position: 0 }, repeated: { cardinality: 'one', position: 0 } };
  checkCheckpointReferences(saved.frame, saved.references, slots);
  for (const alter of [
    (value) => {
      value.frame.input = {};
    },
    (value) => {
      value.frame.currentInput = {};
    },
    (value) => {
      value.frame.children[0].input = {};
    },
    (value) => {
      value.frame.children[0].state.output = {};
    },
    (value) => {
      value.frame.children[1].state.progress.currentInput = {};
    },
  ]) {
    const invalid = copy(saved);
    alter(invalid);
    assert.throws(() => decodeCheckpointFrame(invalid.frame, binding, layout), /invalid domain/);
  }
  const liveCodec = { ...codec, decode: () => new Date(0) };
  assert.throws(() => decodeCheckpointFrame(saved.frame, { ...binding, input: liveCodec }, layout), /ordinary data/);
  assert.throws(() => decodeCheckpointFrame(saved.frame, binding, []), /declaration position/);
  assert.throws(() => checkCheckpointReferences(saved.frame, { chosen: saved.references.chosen }, slots), /slots differ/);
  assert.throws(() => checkCheckpointReferences(saved.frame, { ...saved.references, all: saved.references.chosen }, slots), /cardinality/);
  assert.throws(() => checkCheckpointReferences(saved.frame, saved.references, { ...slots, chosen: { cardinality: 'one', position: 1 } }), /different child declaration/);
  assert.throws(() => decodeCheckpointFrame(saved.frame, binding, [{ kind: 'node', binding: { ...childBinding, version: 2 } }]), /contract is incompatible/);
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {readFileSync} from 'node:fs';
    import { cloneCheckpointImage } from '@capix/checkpoint';
    import {decodeCheckpointFrame} from '@capix/server-runtime/construction';
    const render = (value) => 'domain:' + value.text;
    const codec = { decode(v) { if (v?.tag !== 'domain' || typeof v.text !== 'string') throw new Error('invalid domain'); return { text: v.text }; } };
    const saved = cloneCheckpointImage(JSON.parse(readFileSync(0, 'utf8')));
    const binding = { key: 'domain-parent', version: 1, input: codec, output: codec };
    const child = { key: 'domain-child', version: 1, input: codec, output: codec };
    const decoded = decodeCheckpointFrame(saved.frame, binding, [{ kind: 'node', binding: child }]);
    process.stdout.write(JSON.stringify([render(decoded.input), render(decoded.currentInput), ...decoded.children.flatMap(c => [render(c.input), render(c.state.progress.currentInput), render(c.state.output)])]));
  `,
    ],
    { input: JSON.stringify(saved), encoding: 'utf8', cwd: process.cwd() },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['domain:parent-initial', 'domain:parent-current', 'domain:first-initial', 'domain:first-current', 'domain:first-output', 'domain:second-initial', 'domain:second-current', 'domain:second-output']);
});

test('real factory declarations preserve scoped child identities, duplicate definitions and reference arrays across processes', () => {
  const worker = new URL('./fixtures/v5-author.mjs', import.meta.url);
  const run = (mode, input, variant) => spawnSync(process.execPath, [worker.pathname, mode, ...(variant ? [variant] : [])], { input, encoding: 'utf8', cwd: process.cwd() });
  const captured = run('capture');
  assert.equal(captured.status, 0, captured.stderr);
  const image = JSON.parse(captured.stdout).image;
  assert.deepEqual(
    image.frame.children.map((child) => child.target.position),
    [0, 0, 1, 2],
  );
  assert.equal(image.frame.children[3].contract, undefined);
  assert.equal(image.frame.children.length, 4, 'slots select a subset while the full relationship frame remains saved');
  assert.equal(image.references.chosen.contextId, image.references.repeated.contextId);
  const resumed = run('restore', captured.stdout);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout), { state: { expected: 'first', count: 2 }, output: 'first', all: ['second', 'first'], plain: 'plain', children: 4, same: true });
  for (const variant of ['version', 'swapped']) {
    const rejected = run('restore', captured.stdout, variant);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /incompatible|different child declaration/);
  }
  for (const variant of ['forged-point', 'forged-reference', 'wrong-declaration', 'live-acceptance']) {
    const rejected = run('capture', undefined, variant);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /registered|foreign|different child declaration|ordinary data/);
    assert.equal(rejected.stdout, '', 'rejected capture must not save a partial parent image');
  }
});
