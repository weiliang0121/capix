import { RuntimeError } from '../errors/error.js';
import type { CheckpointImage, CheckpointDelivery, CheckpointHead, CheckpointChild, CheckpointReference } from './contract.js';
import type { CheckpointValue } from '@capix/contracts';

export const CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
const fail = (message: string): never => {
  throw new Error(`Invalid checkpoint: ${message}`);
};

/** Own data properties only: capture never invokes getters, toJSON or entity methods. */
export function cloneCheckpointValue(value: unknown): CheckpointValue {
  const ancestors = new Set<object>();
  let count = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): CheckpointValue => {
    if (++count > 100000 || depth > 64) return fail('structure limit exceeded');
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8');
    else bytes += 8;
    if (bytes > CHECKPOINT_MAX_BYTES) return fail('byte limit exceeded');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object') return fail('only finite JSON data is supported');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return fail('live objects are not supported');
    if (ancestors.has(item)) return fail('cyclic value');
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return fail('symbol property');
      const output: Record<string, CheckpointValue> = {};
      const values: CheckpointValue[] = [];
      const keys = Object.keys(descriptors).filter((key) => !array || key !== 'length');
      if (array && keys.length !== item.length) return fail('sparse or extended array');
      for (const key of keys) {
        const property = descriptors[key]!;
        if (!('value' in property) || !property.enumerable) return fail('accessor or hidden property');
        bytes += Buffer.byteLength(key, 'utf8');
        const child = visit(property.value, depth + 1);
        if (array) {
          if (key !== String(values.length)) return fail('non-index array property');
          values.push(child);
        } else Object.defineProperty(output, key, { value: child, enumerable: true, writable: false, configurable: false });
      }
      return Object.freeze(array ? values : output);
    } finally {
      ancestors.delete(item);
    }
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CHECKPOINT_MAX_BYTES) fail('encoded byte limit exceeded');
  return result;
}
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: any): boolean => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const integer = (value: any, minimum = 0): boolean => Number.isSafeInteger(value) && value >= minimum;
const contract = (value: any): boolean => object(value) && text(value.key) && integer(value.version, 1);
const identity = (value: any): boolean => object(value) && text(value.contextId) && ['scene', 'group', 'node'].includes(value.kind) && !Object.hasOwn(value, 'level') && (value.parentContextId === undefined || text(value.parentContextId));
const progress = (value: any): boolean => object(value) && integer(value.round, 1) && value.round <= 2 && ['execute', 'receive', 'handling'].includes(value.phase) && Object.hasOwn(value, 'currentInput');

/** References never substitute for the complete parent-owned relationship frame. */
export function checkpointReferenceChild(value: unknown, children: readonly CheckpointChild[]): CheckpointChild {
  const reference: any = value;
  if (!object(reference) || Object.keys(reference).some((key) => !['contextId', 'parentContextId', 'parentRound', 'order', 'target'].includes(key)) || !text(reference.contextId) || !text(reference.parentContextId) || !integer(reference.parentRound, 1) || !integer(reference.order) || !object(reference.target) || Object.keys(reference.target).length !== 1 || !integer(reference.target.position)) return fail('invalid child reference');
  const child = children.find((entry) => entry.identity.contextId === reference.contextId);
  if (!child || reference.parentContextId !== child.identity.parentContextId || reference.parentRound !== child.round || reference.order !== child.order || reference.target.position !== child.target.position) return fail('child reference differs from its parent-owned relationship');
  return child;
}

export function checkpointReference(child: CheckpointChild): CheckpointReference {
  if (!child.identity.parentContextId) return fail('child reference requires parent identity');
  return Object.freeze({ contextId: child.identity.contextId, parentContextId: child.identity.parentContextId, parentRound: child.round, order: child.order, target: Object.freeze({ position: child.target.position }) });
}

export function cloneCheckpointImage(value: unknown): CheckpointImage {
  const image: any = cloneCheckpointValue(value);
  if (object(image) && Number.isSafeInteger(image.formatVersion) && image.formatVersion !== 5) throw new RuntimeError('CHECKPOINT_FORMAT_UNSUPPORTED', 'Only checkpoint formatVersion 5 is supported; historical content and records remain readable.', { formatVersion: image.formatVersion });
  if (!object(image) || !text(image.id) || image.formatVersion !== 5 || !contract(image.contract) || !text(image.point) || !Object.hasOwn(image, 'state') || !object(image.references)) fail('invalid image; only checkpoint formatVersion 5 is supported');
  const frame = image.frame;
  if (!object(frame) || !identity(frame.owner) || !integer(frame.round, 1) || frame.round > 2 || frame.phase !== 'execute' || !Object.hasOwn(frame, 'input') || !Object.hasOwn(frame, 'currentInput') || !integer(frame.nextChildOrder) || !Array.isArray(frame.children) || frame.children.length > 4096) fail('invalid frame');
  const ids = new Set<string>();
  let previousOrder = -1;
  for (const child of frame.children) {
    if (!object(child) || !identity(child.identity) || child.identity.parentContextId !== frame.owner.contextId || child.identity.contextId === frame.owner.contextId || ids.has(child.identity.contextId) || !integer(child.round, 1) || child.round > frame.round || !integer(child.order) || child.order >= frame.nextChildOrder || child.order <= previousOrder || !Object.hasOwn(child, 'input') || !object(child.target) || Object.keys(child.target).length !== 1 || !integer(child.target.position) || (child.key !== undefined && !text(child.key)) || (child.contract !== undefined && !contract(child.contract))) fail('invalid child identity, declaration position or order');
    const allowed = frame.owner.kind === 'node' ? [] : ['group', 'node'];
    if (!allowed.includes(child.identity.kind)) fail('invalid child structure kind');
    const state = child.state;
    if (!object(state)) fail('invalid child state');
    if (state.kind === 'waiting') {
      if (!child.contract) fail('waiting child needs a resumable contract');
    } else if (state.kind === 'returned') {
      if (!Object.hasOwn(state, 'output') || !progress(state.progress) || !object(state.reception) || !['pending', 'receiving', 'accepted', 'failed'].includes(state.reception.kind)) fail('invalid child reception');
      const receptionContract = state.reception.contract;
      if (receptionContract !== undefined && (state.reception.kind === 'pending' || !object(receptionContract) || Object.keys(receptionContract).length !== 1 || !integer(receptionContract.position))) fail('invalid reception contract position');
      if (state.reception.kind === 'accepted' && receptionContract !== undefined && !Object.hasOwn(state.reception, 'output')) fail('contracted reception requires encoded output');
      if (state.reception.kind === 'failed') {
        const reception = state.reception;
        const continuation = frame.continuation;
        if (child.round !== 1 || frame.round !== 2 || !object(reception.error) || !text(reception.error.code) || typeof reception.error.message !== 'string' || !object(reception.failure) || reception.failure.kind !== 'exception' || reception.failure.contextId !== frame.owner.contextId || !text(reception.failure.contract) || !['execute', 'receive'].includes(reception.failure.phase) || continuation?.stage !== 'handling' || continuation.origin?.kind !== 'child-reception') fail('invalid handled child reception history');
        if (checkpointReferenceChild(continuation.origin.child, frame.children) !== child) fail('reception failure is not the accepted continuation origin');
      }
    } else if (state.kind === 'failed') {
      if (state.reception !== undefined) {
        const reception = state.reception;
        // The delivery belongs to this direct child. Its diagnostic can retain a
        // deeper fault's context ID; that ID never grants a child relationship.
        if (!progress(state.progress) || !object(state.error) || !text(state.error.code) || typeof state.error.message !== 'string' || !object(state.failure) || !['error', 'exception'].includes(state.failure.kind) || !text(state.failure.contextId) || !['execute', 'receive', 'handling'].includes(state.failure.phase) || (state.failure.kind === 'exception' ? !text(state.failure.contract) : state.failure.contract !== undefined) || Object.hasOwn(state, 'output')) fail('invalid handled child failure');
        if (!object(reception) || reception.kind !== 'handled' || Object.keys(reception).some((key) => !['kind', 'contract', 'output'].includes(key))) fail('invalid handled failure reception');
        const receptionContract = reception.contract;
        if (receptionContract !== undefined && (!object(receptionContract) || Object.keys(receptionContract).length !== 1 || !integer(receptionContract.position) || !Object.hasOwn(reception, 'output'))) fail('invalid handled reception contract');
      } else if (child.round >= frame.round || !progress(state.progress) || !object(state.error) || !text(state.error.code) || typeof state.error.message !== 'string' || !object(state.failure) || state.failure.kind !== 'exception' || state.failure.contextId !== child.identity.contextId || !text(state.failure.contract) || !['execute', 'receive', 'handling'].includes(state.failure.phase)) fail('invalid historical child failure');
    } else fail('unsupported child state');
    ids.add(child.identity.contextId);
    previousOrder = child.order;
  }
  const continuation = frame.continuation;
  if (frame.round === 1 && continuation !== undefined) fail('first round cannot have continuation');
  if (frame.round === 2 && continuation === undefined) fail('second round requires accepted continuation');
  if (continuation !== undefined) {
    if (!object(continuation) || Object.keys(continuation).some((key) => !['fromRound', 'stage', 'reason', 'origin'].includes(key)) || continuation.fromRound !== 1 || !['accept', 'handling'].includes(continuation.stage) || !text(continuation.reason)) fail('invalid continuation');
    if (continuation.stage === 'accept' && continuation.origin !== undefined) fail('acceptance continuation cannot have exception origin');
    if (continuation.stage === 'handling' && !object(continuation.origin)) fail('handled continuation needs exception origin');
    const origin = continuation.origin;
    if (origin?.kind === 'self') {
      if (Object.keys(origin).some((key) => !['kind', 'phase'].includes(key)) || !['execute', 'accept'].includes(origin.phase)) fail('invalid self continuation origin');
    } else if (origin !== undefined) {
      if (!object(origin) || Object.keys(origin).some((key) => !['kind', 'child'].includes(key)) || !['child-return', 'child-reception'].includes(origin.kind)) fail('invalid child continuation origin');
      const child = checkpointReferenceChild(origin.child, frame.children);
      if (child.round !== 1) fail('continuation origin must belong to preceding parent round');
      if (origin.kind === 'child-return' && child.state.kind !== 'failed') fail('child-return continuation needs failed child');
      if (origin.kind === 'child-reception' && (child.state.kind !== 'returned' || child.state.reception.kind !== 'failed')) fail('child-reception continuation needs failed reception');
    }
  }
  for (const value of Object.values(image.references)) {
    if (Array.isArray(value)) value.forEach((reference) => checkpointReferenceChild(reference, frame.children));
    else checkpointReferenceChild(value, frame.children);
  }
  return image as CheckpointImage;
}
export function cloneCheckpointDelivery(value: unknown): CheckpointDelivery {
  const delivery: any = cloneCheckpointValue(value);
  if (!object(delivery) || !['succeeded', 'failed', 'cancelled'].includes(delivery.status) || (delivery.status === 'succeeded' && (!Object.hasOwn(delivery, 'output') || !progress(delivery.progress)))) fail('invalid delivery');
  return delivery as CheckpointDelivery;
}
export function cloneCheckpointHead(value: CheckpointHead): CheckpointHead {
  if (!object(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail('invalid head');
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(properties)) {
    if (typeof key !== 'string' || !['revision', 'image', 'delivery'].includes(key)) return fail('invalid head property');
    const property = properties[key]!;
    if (!('value' in property) || !property.enumerable) fail('accessor or hidden head property');
  }
  const revision = properties.revision?.value;
  if (typeof revision !== 'number' || !integer(revision, 1) || !properties.image) return fail('invalid head revision or image');
  // Images and final deliveries have independent storage budgets. Validate the envelope
  // without evaluating accessors or copying their two payloads through one shared budget.
  return Object.freeze({ revision, image: cloneCheckpointImage(properties.image.value), ...(properties.delivery ? { delivery: cloneCheckpointDelivery(properties.delivery.value) } : {}) });
}
