import assert from 'node:assert/strict';
import { Invocation, InvocationContext, InvocationObservation, ObserverSession, RuntimeErrorHelper, failureFact, prepareCheckpointRestoration } from '@weiliang0121/capix-invocation';
import { cloneCheckpointImage, cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { FactStore } from './fact-store.mjs';
import { LifecycleFacts } from './lifecycle-facts.mjs';

const contractOf = (binding) => (binding ? { key: binding.key, version: binding.version } : undefined);
const receptionOf = (binding) => (binding ? { position: binding.position, childPosition: binding.childPosition } : undefined);
const failureOf = (failure) => (failure ? { ...failureFact(failure), ...(failure.receptionAllowed === undefined ? {} : { receptionAllowed: failure.receptionAllowed }) } : undefined);
const diagnosticOf = (error) => RuntimeErrorHelper.format(error);
const encodeFact = (codec, value) => cloneCheckpointValue(codec ? codec.encode(value) : value);

// Explicit experiment instrumentation at PUBLIC mechanism methods. No prototype
// patch, private import, Frame-to-delta diff, or production observer contract is
// introduced. Deterministic pure-data codecs are the fixture domain. Encoding
// at the establishment boundary is a candidate, not current production policy.
export class LifecycleAdapter {
  facts;
  models = new Map();
  invocations = new Map();
  snapshots = [];
  comparisons = [];
  #relations = new WeakMap();
  #options;

  constructor(options = {}) {
    this.#options = options;
    this.facts = new FactStore(options.path ?? ':memory:');
    this.store = {
      read: (id) => {
        if (!this.facts.readHead(id)) return undefined;
        return (this.models.get(id) ?? LifecycleFacts.reopen(this.facts, id)).readHead();
      },
      save: (image, expectedRevision) => {
        const invocation = this.invocations.get(image.frame.owner.contextId);
        const model = this.models.get(image.frame.owner.contextId);
        assert.ok(invocation && model, 'Unknown mechanism owner');
        assert.equal(invocation.context.progress.round, 1, 'Only the existing single-round path is under test');
        assert.equal(invocation.context.continuation, undefined, 'Legacy continuation is not inferred');
        const frame = model.projectFrame({ round: invocation.context.progress.round, phase: invocation.context.progress.phase });
        assert.equal(frame.nextChildOrder, invocation.children.nextOrder, 'Creation counter differs from mechanism');
        // image.frame is the ORACLE only. No relation or input is learned here.
        assert.deepEqual(frame, image.frame, 'Stable lifecycle projection differs from actual Frame');
        const meta = { id: image.id, formatVersion: image.formatVersion, contract: image.contract, point: image.point, state: image.state, references: image.references };
        const expected = cloneCheckpointImage({ ...meta, frame });
        const receipt = model.checkpoint(meta, expectedRevision);
        assert.deepEqual(model.readHead().image, expected);
        this.snapshots.push(structuredClone(image));
        this.comparisons.push({ contextId: image.frame.owner.contextId, point: image.point, children: frame.children.length });
        this.#options.afterSave?.(image, receipt);
        return receipt;
      },
      finish: (id, revision, delivery) => {
        this.#options.beforeFinish?.(id, delivery);
        const model = this.models.get(id);
        assert.ok(model, 'Unknown finish owner');
        const receipt = model.finish(delivery, revision);
        this.#options.afterFinish?.(id, delivery);
        return receipt;
      },
    };
  }

  #progress(target) {
    return { round: target.context.progress.round, phase: target.context.progress.phase, currentInput: encodeFact(target.checkpointBinding?.input, target.context.currentInput) };
  }

  #register(parent, relation) {
    const child = relation.invocation;
    const contract = contractOf(child.checkpointBinding);
    this.models.get(parent.context.id).registerChild({
      identity: child.identity,
      target: { position: relation.declarationPosition },
      ...(contract ? { contract } : {}),
      round: relation.round,
      order: relation.order,
      ...(relation.key ? { key: relation.key } : {}),
      input: encodeFact(child.checkpointBinding?.input, child.context.input),
    });
    this.#wrapRelation(parent, relation);
  }

  #sync(parent, relation) {
    const before = this.#relations.get(relation);
    assert.ok(before, 'Relation must have an authenticated creation/baseline');
    const model = this.models.get(parent.context.id);
    const child = relation.invocation;
    const returned = relation.returned;
    if (returned && before.returned !== returned) {
      const outcome = returned.status === 'succeeded' ? { status: 'succeeded', output: encodeFact(child.checkpointBinding?.output, returned.output) } : { status: 'failed', diagnostic: returned.diagnostic ?? diagnosticOf(returned.error), failure: failureOf(returned.failure) };
      model.returned(child.context.id, outcome, this.#progress(child));
      before.returned = returned;
    }
    const reception = relation.reception;
    if (before.reception === reception) return;
    const contract = receptionOf(reception.contract);
    if (reception.status === 'receiving') {
      if (before.restoredReception) {
        // A resumed receiver starts a new activity under the SAME established
        // contract. It does not establish the pending→receiving fact twice.
        assert.equal(before.reception.status, 'receiving');
        assert.equal(before.reception.contract, reception.contract);
        before.restoredReception = false;
      } else model.receiving(child.context.id, contract);
    } else if (reception.status === 'accepted' || reception.status === 'handled') model.received(child.context.id, reception.status, encodeFact(reception.contract?.codec, reception.output), contract);
    else if (reception.status === 'failed') model.receptionFailed(child.context.id, { diagnostic: reception.diagnostic ?? diagnosticOf(reception.error), ...(reception.failure ? { failure: failureOf(reception.failure) } : {}), source: reception.failure ? 'work' : 'observation' }, contract);
    else assert.equal(reception.status, 'pending');
    before.reception = reception;
  }

  #wrapRelation(parent, relation, baseline = false) {
    if (this.#relations.has(relation)) return;
    this.#relations.set(relation, { returned: baseline ? relation.returned : undefined, reception: relation.reception, restoredReception: baseline && relation.reception.status === 'receiving' });
    const returnedWith = relation.returnedWith.bind(relation);
    relation.returnedWith = (result) => {
      try {
        return returnedWith(result);
      } finally {
        this.#sync(parent, relation);
      }
    };
    for (const method of ['accept', 'handle']) {
      const original = relation[method].bind(relation);
      relation[method] = async (callback, contract) => {
        try {
          return await original((value) => {
            // Restored calls intentionally suppress ordinary observation. The
            // real receiver entry still exposes its already-installed contract.
            this.#sync(parent, relation);
            return callback(value);
          }, contract);
        } finally {
          this.#sync(parent, relation);
        }
      };
    }
  }

  #wrapChildren(invocation, restored) {
    const children = invocation.children;
    if (restored) for (const relation of children.values()) this.#wrapRelation(invocation, relation, true);
    const attach = children.attach.bind(children);
    children.attach = (target, options) => {
      try {
        const relation = attach(target, options);
        this.#register(invocation, relation);
        return relation;
      } catch (error) {
        // Strict attach observation can fail AFTER the real relation was added.
        // Exact-target lookup handles that exception; no normal history scan.
        let relation;
        try {
          relation = children.get(target);
        } catch {
          throw error;
        }
        if (!this.#relations.has(relation)) this.#register(invocation, relation);
        throw error;
      }
    };
    const replace = children.replaceSaved.bind(children);
    children.replaceSaved = (id, target, state) => {
      const returned = this.models.get(invocation.context.id).relation(id).returned;
      replace(id, target, state);
      const relation = children.get(target);
      if (returned) {
        // Reinstalling the exact saved delivery creates fresh live wrappers,
        // not another return or reception boundary. Public restoration already
        // authenticated this saved relationship before calling replaceSaved.
        this.#relations.set(relation, { returned: relation.returned, reception: relation.reception, restoredReception: relation.reception.status === 'receiving' });
        return;
      }
      // This records authentic restoration installation, not a fabricated
      // business returned event. Its origin is explicit in the experiment path.
      this.#sync(invocation, relation);
    };
  }

  create({ input = null, parent, position = 0, key, receiveFailure = false, binding, execute, close, observe, signal = new AbortController().signal, kind = parent ? 'node' : 'group', context = new InvocationContext(input), restore }) {
    const identity = { contextId: context.id, kind, ...(parent ? { parentContextId: parent.context.id } : {}) };
    const model = restore ? LifecycleFacts.reopen(this.facts, context.id) : new LifecycleFacts(this.facts, { identity, input: encodeFact(binding?.input, context.input), contract: contractOf(binding) });
    this.models.set(context.id, model);
    const complete = context.complete.bind(context);
    context.complete = (output) => {
      complete(output);
      model.workTerminal({ status: 'succeeded', output });
    };
    const fail = context.fail.bind(context);
    context.fail = (error, failure) => {
      fail(error, failure);
      model.workTerminal({ status: 'failed', diagnostic: diagnosticOf(error), ...(failure ? { failure: failureOf(failure) } : {}) });
    };
    const observer = {
      observe: (fact) => {
        if (fact.kind !== 'relation' || fact.change.kind === 'attached') return;
        const owner = this.invocations.get(context.id);
        const target = this.invocations.get(fact.relation.childContextId);
        assert.ok(owner && target, 'Observation cannot discover an unregistered target');
        this.#sync(owner, owner.children.get(target));
      },
    };
    const sessions = [new ObserverSession(observer, 'propagate')];
    if (observe) sessions.push(new ObserverSession({ observe }, 'propagate'));
    const invocation = new Invocation({
      context,
      identity,
      signal,
      ...(parent ? { parent: { invocation: parent, declarationPosition: position, key, receiveFailure } } : {}),
      ...(restore ? { restore } : {}),
      ...(binding ? { checkpoints: { store: this.store } } : {}),
      work: { execute: execute ?? (() => assert.fail('Unexpected execute instead of resume')), ...(binding ? { checkpoint: binding } : {}), ...(close ? { close } : {}) },
      observation: new InvocationObservation(sessions, new Map()),
    });
    this.invocations.set(context.id, invocation);
    this.#wrapChildren(invocation, Boolean(restore));
    return invocation;
  }

  resume(contextId, { binding, parent, signal, ...options }) {
    const head = this.store.read(contextId);
    assert.ok(head, 'Missing checkpoint');
    const identity = head.image.frame.owner;
    const restore = prepareCheckpointRestoration({ store: this.store }, binding, contextId, { kind: identity.kind, ...(parent ? { parentContextId: parent.context.id } : {}) });
    const context = new InvocationContext(binding.input.decode(head.image.frame.input));
    context.installCheckpoint({ id: contextId, round: head.image.frame.round, currentInput: binding.input.decode(head.image.frame.currentInput) });
    return this.create({ ...options, parent, binding, signal, context, kind: identity.kind, restore });
  }

  close() {
    this.facts.close();
  }
}
