import assert from 'node:assert/strict';
import { cloneCheckpointImage, cloneCheckpointDelivery, checkpointSaveReceipt, checkpointFinishReceipt } from '@capix/checkpoint';
import { FactCall } from './fact-call.mjs';
import { identity as carrierIdentity, stableCodec } from './fact-store.mjs';
import { StableValues } from './stable.mjs';

const format = 'lifecycle-facts-study@1';
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

function checkIdentity(value) {
  assert.ok(value && text(value.contextId) && ['scene', 'group', 'node'].includes(value.kind), 'Invalid invocation identity');
  assert.ok(
    Object.keys(value).every((key) => ['contextId', 'kind', 'parentContextId'].includes(key)),
    'Unexpected invocation identity field',
  );
  assert.ok(value.parentContextId === undefined || text(value.parentContextId), 'Invalid parent identity');
}

function checkContract(value) {
  assert.ok(value && text(value.key) && Number.isSafeInteger(value.version) && value.version > 0, 'Invalid checkpoint contract');
}

function checkOutcome(value) {
  assert.ok(value && ['succeeded', 'failed', 'cancelled'].includes(value.status), 'Invalid boundary outcome');
  if (value.status === 'succeeded') assert.ok(Object.hasOwn(value, 'output'), 'Successful boundary needs output');
  else assert.ok(value.diagnostic && text(value.diagnostic.code) && typeof value.diagnostic.message === 'string', 'Failure boundary needs a plain diagnostic');
}

function checkProgress(value) {
  assert.ok(value && [0, 1].includes(value.round) && ['execute', 'receive', 'handling'].includes(value.phase) && Object.hasOwn(value, 'currentInput'), 'Only initial or first-round progress is supported');
}

function freshProjection() {
  return { children: new Map(), nextChildOrder: 0, work: null };
}

// An isolated boundary model, not an Invocation or a new production store.
// FactCall is deliberately kept active as a transaction/material carrier. Its
// simplified child state machine is not used; lifecycle qualification is here.
export class LifecycleFacts {
  #store;
  #carrier;
  #values;
  #projection = freshProjection();
  #nodes = new Map();
  #tail = null;
  #sequence = 0;
  #revision = 0;
  #checkpoint = null;
  #delivery = null;
  #lastImage;
  #durableDelivery;
  #uncertain = false;
  #imageIds = new Set();
  identity;
  input;
  contract;
  stats = { boundaries: 0, coldBoundaries: 0, projections: 0, projectedChildren: 0 };

  constructor(store, { identity, input, contract }, restored) {
    checkIdentity(identity);
    checkContract(contract);
    this.#store = store;
    this.#values = new StableValues();
    this.identity = this.#values.own(identity);
    this.input = this.#values.own(input);
    this.contract = this.#values.own(contract);
    for (const key of ['identity', 'input', 'contract']) Object.defineProperty(this, key, { value: this[key], writable: false, configurable: false, enumerable: true });
    const descriptor = { format, identity: this.identity, input: this.input, contract: this.contract };
    const codec = stableCodec(this.#values);
    if (restored) {
      assert.deepEqual(restored.values.get(restored.head.input), descriptor, 'Restored invocation descriptor changed');
      assert.equal(restored.head.status, 'active', 'Carrier terminal is not an Invocation delivery');
      this.#carrier = new FactCall(store, restored.head.identity, undefined, { values: this.#values, codec, restored });
      this.#load(restored);
    } else {
      const carrier = carrierIdentity(identity.contextId, identity.parentContextId ?? null, `lifecycle:${identity.kind}`, 0, format);
      this.#carrier = new FactCall(store, carrier, descriptor, { values: this.#values, codec });
    }
  }

  static reopen(store, contextId) {
    const codec = stableCodec();
    const restored = store.restore(contextId, new Map([[codec.key, codec]]));
    const descriptor = restored.values.get(restored.head.input);
    assert.equal(descriptor?.format, format, 'Not a lifecycle facts carrier');
    return new LifecycleFacts(store, descriptor, restored);
  }

  #active() {
    assert.ok(!this.#uncertain, 'Lifecycle commit uncertain; reopen durable state');
    assert.ok(!this.#durableDelivery, 'Final lifecycle delivery cannot advance');
  }

  #expected(revision) {
    this.#active();
    assert.ok(integer(revision) && revision < Number.MAX_SAFE_INTEGER, 'Invalid expected revision');
    assert.equal(revision, this.#revision, 'Lifecycle revision conflict');
  }

  #receptionContract(value, relation) {
    if (value === undefined) return;
    assert.ok(integer(value.position) && integer(value.childPosition), 'Invalid reception contract');
    assert.equal(value.childPosition, relation.target.position, 'Reception targets a different declaration');
    assert.ok(
      Object.keys(value).every((key) => ['position', 'childPosition'].includes(key)),
      'Unexpected reception contract field',
    );
  }

  #transition(projection, type, payload) {
    if (type === 'register') {
      const child = payload;
      checkIdentity(child.identity);
      assert.ok(this.identity.kind !== 'node' && child.identity.kind !== 'scene', 'Invalid child structure kind');
      assert.equal(child.identity.parentContextId, this.identity.contextId, 'Wrong child parent');
      assert.notEqual(child.identity.contextId, this.identity.contextId, 'Self child');
      assert.ok(!projection.children.has(child.identity.contextId), 'Duplicate child identity');
      assert.ok(child.target && integer(child.target.position) && Object.keys(child.target).length === 1, 'Invalid target position');
      assert.equal(child.round, 1, 'Only first-round relationships are supported');
      assert.equal(child.order, projection.nextChildOrder, 'Inaccurate child order');
      assert.ok(Object.hasOwn(child, 'input'), 'Child needs input');
      assert.ok(child.key === undefined || text(child.key), 'Invalid relation key');
      if (child.contract !== undefined) checkContract(child.contract);
      return () => {
        projection.children.set(child.identity.contextId, { ...child, returned: null, progress: null, reception: { status: 'pending' } });
        projection.nextChildOrder++;
      };
    }
    if (type === 'work-terminal') {
      assert.equal(projection.work, null, 'Work terminal already established');
      checkOutcome(payload);
      return () => {
        projection.work = payload;
      };
    }
    const relation = projection.children.get(payload.childId);
    assert.ok(relation, 'Unknown child boundary');
    let next;
    if (type === 'returned') {
      assert.equal(relation.returned, null, 'Child already returned');
      checkOutcome(payload.outcome);
      checkProgress(payload.progress);
      assert.ok(payload.progress.round !== 0 || payload.outcome.status !== 'succeeded', 'Unstarted child cannot have successful work output');
      next = { ...relation, returned: payload.outcome, progress: payload.progress };
    } else if (type === 'receiving') {
      assert.ok(relation.returned, 'Child has not returned');
      assert.equal(relation.reception.status, 'pending', 'Reception is not pending');
      assert.equal(relation.progress.round, 1, 'Unstarted child failure is diagnostic, not a receivable work result');
      assert.ok(relation.returned.status === 'succeeded' || (relation.returned.status === 'failed' && relation.returned.failure?.receptionAllowed === true), 'Protected or cancelled failure cannot be received');
      this.#receptionContract(payload.contract, relation);
      next = { ...relation, reception: { status: 'receiving', ...(payload.contract ? { contract: payload.contract } : {}) } };
    } else if (type === 'received' || type === 'reception-failed') {
      assert.equal(relation.reception.status, 'receiving', 'Reception has not started');
      this.#receptionContract(payload.contract, relation);
      assert.deepEqual(payload.contract, relation.reception.contract, 'Reception contract changed');
      if (type === 'received') {
        assert.ok(['accepted', 'handled'].includes(payload.status), 'Unknown reception result');
        assert.equal(payload.status, relation.returned.status === 'succeeded' ? 'accepted' : 'handled', 'Reception result disagrees with child return');
        next = { ...relation, reception: { status: payload.status, output: payload.output, ...(payload.contract ? { contract: payload.contract } : {}) } };
      } else {
        assert.ok(payload.diagnostic && text(payload.diagnostic.code) && typeof payload.diagnostic.message === 'string', 'Reception failure requires diagnostic');
        assert.ok(payload.source !== undefined && payload.source !== null, 'Reception failure requires explicit source');
        next = { ...relation, reception: { status: 'failed', diagnostic: payload.diagnostic, source: payload.source, ...(payload.failure ? { failure: payload.failure } : {}), ...(payload.contract ? { contract: payload.contract } : {}) } };
      }
    } else assert.fail('Unknown lifecycle boundary');
    return () => projection.children.set(payload.childId, next);
  }

  #append(type, payload) {
    this.#active();
    const fixed = this.#values.own(payload);
    const apply = this.#transition(this.#projection, type, fixed);
    const node = this.#values.own({ kind: 'lifecycle-boundary@1', owner: this.identity.contextId, sequence: this.#sequence + 1, previous: this.#tail, type, payload: fixed });
    const id = this.#carrier.capture(node);
    apply();
    this.#nodes.set(id, node);
    this.#tail = id;
    this.#sequence = node.sequence;
    this.stats.boundaries++;
    return id;
  }

  registerChild(child) {
    return this.#append('register', child);
  }
  returned(childId, outcome, progress) {
    return this.#append('returned', { childId, outcome, progress });
  }
  receiving(childId, contract) {
    return this.#append('receiving', { childId, ...(contract ? { contract } : {}) });
  }
  received(childId, status, output, contract = this.#projection.children.get(childId)?.reception.contract) {
    return this.#append('received', { childId, status, output, ...(contract ? { contract } : {}) });
  }
  receptionFailed(childId, { diagnostic, failure, source }, contract = this.#projection.children.get(childId)?.reception.contract) {
    return this.#append('reception-failed', { childId, diagnostic, source, ...(failure ? { failure } : {}), ...(contract ? { contract } : {}) });
  }
  workTerminal(outcome) {
    return this.#append('work-terminal', outcome);
  }

  get work() {
    return this.#projection.work;
  }
  get durableDelivery() {
    return this.#durableDelivery;
  }
  inspect() {
    return this.#values.own({ workTerminal: this.#projection.work, durableDelivery: this.#durableDelivery ?? null, relations: [...this.#projection.children.values()] });
  }
  relation(childId) {
    return this.#values.own(this.#projection.children.get(childId));
  }
  encodingCounts() {
    return new Map(this.#carrier.encodings);
  }

  #frame(projection, progress) {
    assert.deepEqual(progress, { round: 1, phase: 'execute' }, 'Only current first-round execute frame is supported');
    const children = [];
    for (const relation of projection.children.values()) {
      this.stats.projectedChildren++;
      const { returned, reception } = relation;
      // Keep the existing v5 serialization order: its receipt digest currently
      // authenticates JSON bytes, not a separately canonicalized object graph.
      const base = { identity: relation.identity, target: relation.target, ...(relation.contract ? { contract: relation.contract } : {}), round: relation.round, order: relation.order, ...(relation.key ? { key: relation.key } : {}), input: relation.input };
      const childProgress = relation.progress ? { round: relation.progress.round, phase: relation.progress.phase, currentInput: relation.progress.currentInput } : null;
      if (returned) assert.equal(childProgress.round, 1, 'Unstarted child progress is not checkpoint recovery evidence');
      let state;
      if (!returned) {
        assert.ok(base.contract, 'Waiting child needs its own checkpoint contract');
        state = { kind: 'waiting' };
      } else if (returned.status === 'succeeded') {
        assert.ok(reception.status !== 'failed', 'Current reception failure is not resumable');
        const contract = reception.contract ? { contract: { position: reception.contract.position } } : {};
        state = { kind: 'returned', output: returned.output, progress: childProgress, reception: { kind: reception.status, ...contract, ...(reception.status === 'accepted' && (reception.contract || reception.output !== undefined) ? { output: reception.output } : {}) } };
      } else {
        assert.ok(returned.status === 'failed' && returned.failure?.receptionAllowed === true && reception.status === 'handled', 'Current unhandled, protected, or cancelled child failure is not resumable');
        const failure = { kind: returned.failure.kind, phase: returned.failure.phase, contextId: returned.failure.contextId, ...(returned.failure.contract ? { contract: returned.failure.contract } : {}) };
        state = { kind: 'failed', error: returned.diagnostic, failure, progress: childProgress, reception: { kind: 'handled', ...(reception.contract ? { contract: { position: reception.contract.position } } : {}), ...(reception.contract || reception.output !== undefined ? { output: reception.output } : {}) } };
      }
      children.push({ ...base, state });
    }
    this.stats.projections++;
    return this.#values.own({ owner: this.identity, phase: progress.phase, round: progress.round, input: this.input, currentInput: this.input, nextChildOrder: projection.nextChildOrder, children });
  }

  projectFrame(progress = { round: 1, phase: 'execute' }) {
    return this.#frame(this.#projection, progress);
  }

  #projectionAt(tail) {
    const projection = freshProjection();
    const nodes = [];
    const seen = new Set();
    let cursor = tail;
    while (cursor !== null) {
      assert.ok(typeof cursor === 'string' && !seen.has(cursor), 'Invalid lifecycle chain');
      seen.add(cursor);
      const node = this.#nodes.get(cursor);
      assert.ok(node, 'Checkpoint tail is not an available boundary');
      nodes.push(node);
      cursor = node.previous;
    }
    let sequence = 0;
    for (const node of nodes.reverse()) {
      assert.equal(node.sequence, ++sequence, 'Lifecycle sequence gap');
      this.#transition(projection, node.type, node.payload)();
    }
    return projection;
  }

  #image(meta, projection) {
    assert.equal(meta.kind, 'lifecycle-checkpoint@1', 'Wrong checkpoint material');
    assert.equal(meta.owner, this.identity.contextId, 'Foreign checkpoint material');
    assert.deepEqual(meta.request.contract, this.contract, 'Checkpoint contract changed');
    const request = meta.request;
    return cloneCheckpointImage({ id: request.id, formatVersion: request.formatVersion, contract: request.contract, point: request.point, frame: this.#frame(projection, { round: 1, phase: 'execute' }), state: request.state, references: request.references });
  }

  #commit(checkpoint, delivery, options) {
    assert.ok(
      Object.keys(options).every((key) => key === 'fault'),
      'Carrier lifecycle options cannot be changed',
    );
    this.#uncertain = true;
    const receipt = this.#carrier.save('lifecycle-head', { format, tail: this.#tail, checkpoint, delivery }, { fault: options.fault });
    assert.equal(receipt.revision, this.#revision + 1, 'Carrier revision disagrees');
    this.#revision = receipt.revision;
    this.#checkpoint = checkpoint;
    this.#delivery = delivery;
    this.#uncertain = false;
  }

  checkpoint(request, expectedRevision, options = {}) {
    this.#expected(expectedRevision);
    assert.ok(
      Object.keys(options).every((key) => key === 'fault'),
      'Carrier lifecycle options cannot be changed',
    );
    assert.ok(
      Object.keys(request).every((key) => ['id', 'formatVersion', 'contract', 'point', 'state', 'references'].includes(key)),
      'Frame must be derived from lifecycle boundaries',
    );
    assert.ok(!this.#imageIds.has(request.id), 'Checkpoint identity reused');
    const meta = this.#values.own({ kind: 'lifecycle-checkpoint@1', owner: this.identity.contextId, tail: this.#tail, request });
    const image = this.#image(meta, this.#projection);
    const id = this.#carrier.capture(meta);
    this.#commit(id, null, options);
    this.#lastImage = image;
    this.#imageIds.add(image.id);
    return checkpointSaveReceipt(image, this.#revision);
  }

  finish(delivery, expectedRevision, options = {}) {
    this.#expected(expectedRevision);
    assert.ok(
      Object.keys(options).every((key) => key === 'fault'),
      'Carrier lifecycle options cannot be changed',
    );
    assert.ok(this.#lastImage, 'Cannot finish without a saved checkpoint image');
    const fixed = cloneCheckpointDelivery(delivery);
    const id = this.#carrier.capture({ kind: 'lifecycle-delivery@1', owner: this.identity.contextId, delivery: fixed });
    this.#commit(this.#checkpoint, id, options);
    this.#durableDelivery = fixed;
    return checkpointFinishReceipt(this.identity.contextId, this.#lastImage.id, fixed, this.#revision);
  }

  readHead() {
    return this.#lastImage ? Object.freeze({ revision: this.#revision, image: this.#lastImage, ...(this.#durableDelivery ? { delivery: this.#durableDelivery } : {}) }) : undefined;
  }

  #load(restored) {
    const state = restored.state;
    assert.equal(state?.format, format, 'Wrong lifecycle head format');
    assert.ok(
      Object.keys(state).every((key) => ['format', 'tail', 'checkpoint', 'delivery'].includes(key)),
      'Unknown lifecycle head field',
    );
    this.#revision = restored.head.revision;
    let publishedTail = null;
    let publishedSequence = 0;
    let lastCheckpoint = null;
    let lastDelivery = null;
    let commits = 0;
    // FactStore.restore returns facts in their authenticated publication order.
    // Bind each point request to the boundary tail that existed at publication,
    // rather than accepting a tail that happens to exist somewhere in the log.
    for (const [id, value] of restored.values) {
      const metadata = restored.metadata.get(id);
      if (metadata.kind !== 'material') continue;
      assert.equal(lastDelivery, null, 'Lifecycle fact appeared after final delivery');
      assert.equal(metadata.owner, this.identity.contextId, 'Foreign lifecycle material');
      assert.equal(value.owner, this.identity.contextId, 'Foreign lifecycle payload owner');
      if (value.kind === 'lifecycle-boundary@1') {
        assert.equal(value.previous, publishedTail, 'Lifecycle publication predecessor mismatch');
        assert.equal(value.sequence, ++publishedSequence, 'Lifecycle publication sequence gap');
        this.#nodes.set(id, value);
        publishedTail = id;
      } else if (value.kind === 'lifecycle-checkpoint@1') {
        assert.equal(value.tail, publishedTail, 'Checkpoint did not select its publication boundary');
        assert.equal(value.request.formatVersion, 5, 'Unsupported checkpoint image format');
        assert.deepEqual(value.request.contract, this.contract, 'Historical checkpoint contract changed');
        assert.ok(!this.#imageIds.has(value.request.id), 'Repeated checkpoint identity');
        this.#imageIds.add(value.request.id);
        lastCheckpoint = id;
        commits++;
      } else {
        assert.equal(value.kind, 'lifecycle-delivery@1', 'Unknown lifecycle material');
        assert.ok(lastCheckpoint, 'Final delivery has no preceding checkpoint');
        lastDelivery = id;
        commits++;
      }
    }
    assert.equal(state.tail, publishedTail, 'Head does not select the published boundary tail');
    assert.equal(state.checkpoint, lastCheckpoint, 'Head lost its last checkpoint');
    assert.equal(state.delivery, lastDelivery, 'Head final delivery mismatch');
    assert.equal(this.#revision, commits, 'Lifecycle commit history differs from revision');
    this.#tail = state.tail;
    this.#projection = this.#projectionAt(state.tail);
    this.#sequence = state.tail === null ? 0 : this.#nodes.get(state.tail).sequence;
    assert.equal(this.#sequence, this.#nodes.size, 'Unlinked lifecycle boundary');
    this.stats.coldBoundaries = this.#sequence;
    this.#checkpoint = state.checkpoint;
    this.#delivery = state.delivery;
    assert.ok(typeof state.checkpoint === 'string', 'Durable lifecycle head lacks checkpoint');
    const meta = this.#carrier.material(state.checkpoint);
    this.#lastImage = this.#image(meta, this.#projectionAt(meta.tail));
    if (state.delivery !== null) {
      const delivery = this.#carrier.material(state.delivery);
      assert.equal(delivery.kind, 'lifecycle-delivery@1', 'Wrong final delivery material');
      assert.equal(delivery.owner, this.identity.contextId, 'Foreign final delivery');
      this.#durableDelivery = cloneCheckpointDelivery(delivery.delivery);
    }
  }
}
