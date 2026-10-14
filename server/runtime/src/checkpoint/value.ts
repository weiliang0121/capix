import type { CheckpointValue, CheckpointImage, CheckpointDelivery, CheckpointHead } from './contract.js';

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
const identity = (value: any): boolean => object(value) && text(value.contextId) && ['runtime', 'execution', 'operation', 'attempt'].includes(value.level) && (value.parentContextId === undefined || text(value.parentContextId));
const progress = (value: any): boolean => object(value) && integer(value.round, 1) && value.round <= 2 && ['execute', 'receive', 'handling'].includes(value.phase) && Object.hasOwn(value, 'currentInput');

export function cloneCheckpointImage(value: unknown): CheckpointImage {
  const image: any = cloneCheckpointValue(value);
  if (!object(image) || !text(image.id) || image.formatVersion !== 1 || !contract(image.contract) || !text(image.point) || !Object.hasOwn(image, 'state')) fail('invalid image');
  const frame = image.frame;
  if (!object(frame) || !identity(frame.owner) || !integer(frame.round, 1) || frame.round > 2 || frame.phase !== 'execute' || !Object.hasOwn(frame, 'input') || !Object.hasOwn(frame, 'currentInput') || !integer(frame.nextChildOrder) || !Array.isArray(frame.children) || frame.children.length > 4096) fail('invalid frame');
  const ids = new Set<string>();
  let previousOrder = -1;
  for (const child of frame.children) {
    if (!object(child) || !identity(child.identity) || child.identity.parentContextId !== frame.owner.contextId || child.identity.contextId === frame.owner.contextId || ids.has(child.identity.contextId) || !integer(child.round, 1) || child.round > frame.round || !integer(child.order) || child.order >= frame.nextChildOrder || child.order <= previousOrder || !Object.hasOwn(child, 'input') || (child.key !== undefined && !text(child.key)) || (child.contract !== undefined && !contract(child.contract))) fail('invalid child identity or order');
    const allowed = frame.owner.level === 'runtime' ? ['execution'] : frame.owner.level === 'execution' ? ['operation'] : frame.owner.level === 'operation' ? ['operation', 'attempt'] : [];
    if (!allowed.includes(child.identity.level)) fail('invalid child level');
    const state = child.state;
    if (!object(state)) fail('invalid child state');
    if (state.kind === 'waiting') {
      if (!child.contract) fail('waiting child needs a resumable contract');
    } else if (state.kind === 'returned') {
      if (!Object.hasOwn(state, 'output') || !progress(state.progress) || !object(state.reception) || !['pending', 'receiving', 'accepted'].includes(state.reception.kind)) fail('invalid child reception');
    } else if (state.kind === 'failed') {
      if (child.round >= frame.round || !progress(state.progress) || !object(state.error) || !text(state.error.code) || typeof state.error.message !== 'string' || !object(state.failure) || state.failure.kind !== 'exception' || state.failure.contextId !== child.identity.contextId || !text(state.failure.contract) || !['execute', 'receive', 'handling'].includes(state.failure.phase)) fail('invalid historical child failure');
    } else fail('unsupported child state');
    ids.add(child.identity.contextId);
    previousOrder = child.order;
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
