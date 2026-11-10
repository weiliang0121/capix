import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { test } from 'node:test';

import { cloneCheckpointImage, checkpointReference } from '@weiliang0121/capix-checkpoint';

function image() {
  const child = { identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, round: 1, order: 0, input: { request: 'initial' }, state: { kind: 'returned', output: 'delivered', progress: { round: 2, currentInput: { request: 'child-second' }, phase: 'receive' }, reception: { kind: 'accepted', output: { selected: true } } } };
  return { id: 'point-image', formatVersion: 6, contract: { key: 'parent-contract', version: 1 }, point: 'saved', frame: { owner: { contextId: 'parent', kind: 'group' }, round: 1, phase: 'execute', input: {}, currentInput: {}, nextChildOrder: 1, children: [child] }, state: { selected: true }, references: { chosen: checkpointReference(child), all: [checkpointReference(child)], repeated: checkpointReference(child) } };
}

const copy = (value) => JSON.parse(JSON.stringify(value));

test('real Invocation captures in one process and resumes successful no-CP child acceptance in another', () => {
  const worker = new URL('./fixtures/call.mjs', import.meta.url);
  const first = spawnSync(process.execPath, [fileURLToPath(worker), 'capture'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const saved = JSON.parse(first.stdout);
  assert.equal(saved.image.formatVersion, 6);
  assert.equal(saved.delivery, undefined);
  assert.equal(saved.image.frame.children[0].contract, undefined);
  assert.equal(saved.image.frame.children[0].state.reception.kind, 'pending');
  const second = spawnSync(process.execPath, [fileURLToPath(worker), 'restore'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), input: first.stdout, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const completed = JSON.parse(second.stdout);
  assert.equal(completed.restored, true);
  assert.equal(completed.result, 'external result:accepted');
  assert.equal(completed.head.delivery.status, 'succeeded');
  assert.equal(completed.head.image.frame.children[0].state.reception.kind, 'accepted');
  assert.equal(completed.head.image.frame.children[0].state.reception.output, completed.result);
});

test('production codecs decode complete historical IO into stable data with explicit domain wire encoding', async () => {
  const { decodeCheckpointFrame, checkCheckpointReferences } = await import('@weiliang0121/capix-invocation');
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
    import { cloneCheckpointImage } from '@weiliang0121/capix-checkpoint';
    import {decodeCheckpointFrame} from '@weiliang0121/capix-invocation';
    const render = (value) => 'domain:' + value.text;
    const codec = { decode(v) { if (v?.tag !== 'domain' || typeof v.text !== 'string') throw new Error('invalid domain'); return { text: v.text }; } };
    const saved = cloneCheckpointImage(JSON.parse(readFileSync(0, 'utf8')));
    const binding = { key: 'domain-parent', version: 1, input: codec, output: codec };
    const child = { key: 'domain-child', version: 1, input: codec, output: codec };
    const decoded = decodeCheckpointFrame(saved.frame, binding, [{ kind: 'node', binding: child }]);
    process.stdout.write(JSON.stringify([render(decoded.input), render(decoded.currentInput), ...decoded.children.flatMap(c => [render(c.input), render(c.state.progress.currentInput), render(c.state.output)])]));
  `,
    ],
    { input: JSON.stringify(saved), encoding: 'utf8', cwd: fileURLToPath(new URL('../../', import.meta.url)) },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['domain:parent-initial', 'domain:parent-current', 'domain:first-initial', 'domain:first-current', 'domain:first-output', 'domain:second-initial', 'domain:second-current', 'domain:second-output']);
});
