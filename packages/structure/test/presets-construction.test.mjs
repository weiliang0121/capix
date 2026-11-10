import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sequence, Dynamic, Group, Node } from '@weiliang0121/capix-structure';

test('Sequence validates the whole constructor before claiming any member at declaration', () => {
  const owner = new Group();
  const occupied = new Node({ run: () => 1 });
  owner.add(occupied);
  const free = new Node({ run: () => 2 });
  assert.throws(() => new Sequence([free, occupied]), /parent/);
  assert.throws(() => new Sequence([free, { node: new Node(), input: 123 }]), /functions/);
  assert.throws(() => new Sequence([free, { node: new Node(), result: 123 }]), /reception|object/);
  assert.throws(() => new Sequence([free, {}]), /Node|Group|node|member/i);
  assert.throws(() => new Sequence([free], { output: { result: 123 } }), /output/);
  const sequence = new Sequence([free]);
  assert.deepEqual(sequence.members, [free]);
  assert.equal(sequence.step, undefined);
});

test('Sequence fixes the whole pipeline before aliases or external configuration can change its result at declaration', () => {
  const original = new Node({
    output: { result: Number, delta: String },
    run(work) {
      work.output.emit('original');
      return work.input;
    },
  });
  const replacement = new Node({ run: () => 'wrong-result' });
  const received = [];
  const reception = { succeeded: (value) => value + 1 };
  const step = { node: original, key: 'original', input: ({ input }) => input + 1, delta: (value) => received.push(value), result: reception };
  const steps = [step];
  const sequence = new Sequence(steps);
  const earlierAlias = sequence;
  steps.push(replacement);
  steps[0] = replacement;
  step.node = replacement;
  step.key = 'replacement';
  step.input = () => 100;
  step.delta = () => received.push('wrong');
  reception.succeeded = () => 'wrong';
  step.result = { succeeded: () => 'also-wrong' };
  assert.deepEqual(sequence.steps, [{ node: original, key: 'original' }]);
  assert.equal(earlierAlias, sequence);
  assert.equal(earlierAlias.step, undefined);
  assert.doesNotThrow(() => new Group().add(replacement), 'mutating the original array never registered another member');
});

test('Dynamic validates its whole configuration before claiming members and fixes its progression at construction at declaration', () => {
  const occupied = new Node({ run: () => 1 });
  new Group().add(occupied);
  const free = new Node({ run: () => 2 });
  const decision = new Node({ run: () => ({ kind: 'finish', value: 1 }) });
  assert.throws(() => new Dynamic({ options: { free, occupied }, decide: decision }), /parent/);
  assert.throws(() => new Dynamic({ options: { free }, decide: occupied }), /parent/);
  assert.throws(() => new Dynamic({ options: { free } }), /Node|Group|member/i);
  assert.throws(() => new Dynamic({ options: { free }, decide: decision, maxSteps: -1 }), RangeError);
  assert.throws(() => new Dynamic({ options: { free, invalid: {} }, decide: decision }), /Node|Group|member/i);
  const dynamic = new Dynamic({ options: { free }, decide: decision, maxSteps: 3 });
  assert.equal(dynamic.maxSteps, 3);
  assert.throws(() => {
    dynamic.maxSteps = 4;
  }, TypeError);
  assert.throws(() => {
    dynamic.maxSteps = 5;
  }, TypeError);
  assert.equal(dynamic.options, undefined);
  assert.equal(dynamic.decide, undefined);
});
