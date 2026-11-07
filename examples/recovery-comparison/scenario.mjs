import assert from 'node:assert/strict';
import { fixed, Refusal } from './model.mjs';

export const CUTS = Object.freeze(['initial', 'read-result', 'model-intent', 'model-executed-unconfirmed', 'model-effect', 'child-returned', 'accept-intent', 'entity-executed-unconfirmed', 'entity-effect', 'accepted', 'final']);

function fields(value, names, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a record`);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), `${label} fields differ`);
}

// A hand-written invariant for this fixed three-operation experiment. It does
// not execute either author function or infer invariants from arbitrary code.
// Historical validation deliberately ignores today's unversioned code switches:
// those switches are tested separately by replay matching or by the resumed
// explicit stage. Neither strategy proves arbitrary closures deterministic.
export function validateScenarioHistory(head, commands) {
  fields(head.input, ['query'], 'Root input');
  assert.equal(typeof head.input.query, 'string');
  assert.ok(commands.length <= 3, 'Unexpected command suffix');
  const identities = new Set();
  const positions = [
    { kind: 'resource', name: 'read', member: 'materials' },
    { kind: 'child', name: 'model', member: 'generate' },
    { kind: 'reception', name: 'accept', member: 'generate' },
  ];
  for (const [index, command] of commands.entries()) {
    fields(command, ['ordinal', 'owner', 'policyVersion', 'kind', 'name', 'member', 'input', 'id', 'outcome'], 'Command');
    assert.ok(typeof command.id === 'string' && command.id.length > 0, 'Missing command identity');
    assert.ok(!identities.has(command.id), 'Repeated command identity');
    identities.add(command.id);
    const position = positions[index];
    assert.deepEqual({ kind: command.kind, name: command.name, member: command.member }, position, 'Historical command position differs');
  }
  const read = commands[0];
  if (read) {
    assert.deepEqual(read.input, head.input, 'Historical read differs from fixed root input');
    if (read.outcome !== null) {
      fields(read.outcome, ['text'], 'Read outcome');
      assert.equal(typeof read.outcome.text, 'string');
    }
  }
  const model = commands[1];
  if (model) {
    assert.ok(read?.outcome, 'Model has no original read');
    assert.deepEqual(model.input, { material: read.outcome.text, query: head.input.query, variant: 'original' }, 'Historical model input differs from its fixed material');
    if (model.outcome !== null) {
      fields(model.outcome, ['childId', 'returned'], 'Child delivery');
      assert.equal(model.outcome.childId, model.id, 'Child delivery identity differs');
      const returned = model.outcome.returned;
      assert.ok(returned?.status === 'succeeded' || returned?.status === 'failed', 'Unknown child delivery');
      if (returned.status === 'succeeded') {
        fields(returned, ['status', 'value'], 'Successful child delivery');
        fields(returned.value, ['text'], 'Model reply');
        assert.equal(typeof returned.value.text, 'string');
      } else {
        fields(returned, ['status', 'failure'], 'Failed child delivery');
        fields(returned.failure, ['code', 'message'], 'Business failure');
        assert.equal(returned.failure.code, 'MODEL_DECLINED', 'Only the fixture business failure is representable');
        assert.equal(typeof returned.failure.message, 'string');
      }
    }
  }
  const reception = commands[2];
  if (reception) {
    assert.ok(model?.outcome, 'Reception has no child delivery');
    assert.deepEqual(reception.input, model.outcome, 'Reception refers to a different child delivery');
    if (reception.outcome !== null) {
      fields(reception.outcome, ['childId', 'reception', 'value', 'receipt'], 'Reception outcome');
      assert.equal(reception.outcome.childId, model.id, 'Reception outcome belongs to another child');
      assert.equal(reception.outcome.receipt, reception.id, 'Reception effect receipt identity differs');
      assert.equal(reception.outcome.reception, model.outcome.returned.status === 'succeeded' ? 'accepted' : 'handled', 'Reception rewrites the child outcome');
      fields(reception.outcome.value, ['text', 'saved'], 'Accepted entity result');
      assert.equal(typeof reception.outcome.value.text, 'string');
      assert.equal(reception.outcome.value.saved, true);
    }
  }
  if (head.mode === 'replay') {
    assert.equal(head.point, 'read', 'Replay head cannot supply an explicit program counter');
    assert.deepEqual(head.locals, {});
    return;
  }
  const points = {
    read: { locals: {}, required: 0, maximum: 1 },
    model: { locals: { material: 1 }, required: 1, maximum: 2 },
    accept: { locals: { delivery: 2 }, required: 2, maximum: 3 },
    finish: { locals: { accepted: 3 }, required: 3, maximum: 3 },
  };
  const point = points[head.point];
  assert.ok(point, 'Unknown explicit continuation point');
  assert.deepEqual(head.locals, point.locals, 'Continuation references differ from its point');
  assert.ok(commands.length <= point.maximum, 'Commands advanced beyond the explicit point');
  if (point.required) assert.ok(commands[point.required - 1]?.outcome, 'Continuation point has no completed prerequisite');
}

export class Coordination {
  constructor(journal, world, options = {}, recovering = false) {
    this.journal = journal;
    this.world = world;
    this.options = options;
    this.recovering = recovering;
    this.cursor = 0;
  }

  cut(name) {
    if (this.options.cut === name) process.exit(73);
  }

  descriptor(ordinal, kind, name, member, input) {
    return { ordinal, kind, name, member, input: fixed(input) };
  }

  obtain(spec) {
    this.cursor = spec.ordinal;
    return this.journal.intent(spec);
  }

  read() {
    const spec = this.descriptor(1, 'resource', 'read', 'materials', this.journal.head.input);
    const { command, fresh } = this.obtain(spec);
    if (command.outcome) return command.outcome;
    const receipt = fresh ? this.world.execute(command.id, 'read', spec.input, { text: this.world.source }, (name) => this.cut(name)) : this.world.exact(command.id, 'read', spec.input);
    const result = this.journal.outcome(command, receipt.result);
    this.cut('read-result');
    return result;
  }

  model(material) {
    const input = { material: material.text, query: this.journal.head.input.query, variant: this.options.changedModelInput ? 'changed' : 'original' };
    const spec = this.descriptor(2, 'child', this.options.changedModelName ? 'other-model' : 'model', 'generate', input);
    const { command, fresh } = this.obtain(spec);
    if (command.outcome) return command.outcome;
    this.cut('model-intent');
    const feedback = this.options.modelFailure ? { status: 'failed', failure: { code: 'MODEL_DECLINED', message: 'business failure' } } : { status: 'succeeded', value: { text: `answer: ${input.material}` } };
    const receipt = fresh ? this.world.execute(command.id, 'model', input, feedback, (name) => this.cut(name)) : this.world.exact(command.id, 'model', input);
    const output = this.journal.outcome(command, { childId: command.id, returned: receipt.result });
    this.cut('child-returned');
    return output;
  }

  accept(delivery) {
    const spec = this.descriptor(3, 'reception', 'accept', 'generate', delivery);
    if (this.recovering && delivery.returned.status === 'failed' && !this.journal.command(3)?.outcome) throw new Refusal('Failed child without persisted handling cannot resume');
    const { command, fresh } = this.obtain(spec);
    if (command.outcome) return command.outcome;
    // Production currently refuses a persisted failed child unless its parent
    // handling was already saved. Do not accidentally broaden that promise.
    this.cut('accept-intent');
    this.world.count('mapping');
    const content = delivery.returned.status === 'succeeded' ? delivery.returned.value.text : 'fallback';
    const text = content + (this.options.mappingSuffix ?? '');
    const input = fixed({ childId: delivery.childId, text });
    const receipt = fresh ? this.world.execute(command.id, 'entity', input, { text, saved: true }, (name) => this.cut(name)) : this.world.exact(command.id, 'entity', input);
    const output = this.journal.outcome(command, { childId: delivery.childId, reception: delivery.returned.status === 'succeeded' ? 'accepted' : 'handled', value: receipt.result, receipt: receipt.id });
    this.cut('accepted');
    return output;
  }

  // Explicit continuation reads exact previous operation outcomes by its saved
  // local reference. It does not rerun old coordinator statements.
  local(ordinal, kind) {
    const command = this.journal.command(ordinal);
    assert.ok(command && command.outcome, 'Missing saved local fact');
    assert.equal(command.kind, kind, 'Saved local kind mismatch');
    this.journal.bump('resumeReads');
    return command.outcome;
  }

  outside() {
    if (this.options.unsafeOutside) this.world.count('outside');
  }

  finish(output) {
    assert.equal(this.cursor, this.journal.commands().length, 'Unconsumed historical commands');
    this.journal.terminal('succeeded', output);
    this.cut('final');
    return output;
  }
}

// Candidate author form: ordinary locals reconstructed by replay. Only these
// controlled calls are injectable; arbitrary code between them runs again.
export function replayAuthor(work) {
  work.outside();
  const material = work.read();
  if (work.options.omitModel) return work.finish({ text: material.text });
  const delivery = work.model(material);
  const accepted = work.accept(delivery);
  return work.finish(accepted.value);
}

// Candidate explicit author form: a saved position and references to the same
// immutable operation facts. These four cases are not production CP points.
export function explicitAuthor(work) {
  let head = work.journal.head;
  if (head.point === 'read') {
    work.outside();
    work.read();
    work.journal.advance('model', { material: 1 });
    head = work.journal.head;
  }
  if (head.point === 'model') {
    const material = work.local(head.locals.material, 'resource');
    if (work.options.omitModel) return work.finish({ text: material.text });
    work.model(material);
    work.journal.advance('accept', { delivery: 2 });
    head = work.journal.head;
  }
  if (head.point === 'accept') {
    const delivery = work.local(head.locals.delivery, 'child');
    work.accept(delivery);
    work.journal.advance('finish', { accepted: 3 });
    head = work.journal.head;
  }
  assert.equal(head.point, 'finish', 'Unknown continuation point');
  const accepted = work.local(head.locals.accepted, 'reception');
  work.cursor = 3;
  return work.finish(accepted.value);
}

export function execute(journal, world, mode, options, recovering) {
  let head = journal.head;
  if (!recovering) {
    head = journal.create(mode, { query: 'summarize' }, options.policyVersion ?? 'study@1');
    new Coordination(journal, world, options).cut('initial');
  }
  head = journal.validate(validateScenarioHistory);
  assert.equal(head.mode, mode, 'Continuation mode changed');
  assert.equal(head.policyVersion, options.policyVersion ?? 'study@1', 'Policy version changed');
  if (head.status !== 'active') return { status: 'terminal', result: head.result };
  journal.bump('authorEntries');
  const work = new Coordination(journal, world, options, recovering);
  const result = mode === 'replay' ? replayAuthor(work) : explicitAuthor(work);
  return { status: 'completed', result };
}
