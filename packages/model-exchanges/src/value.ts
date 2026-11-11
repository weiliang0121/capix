import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { requireToolFeedback } from '@weiliang0121/capix-model-provider';
import type { ExchangeOperation, ExchangeReference, ExchangeOriginReference, ExchangeIntakeReceipt, ExchangeFeedbackReceipt } from './types.js';
import { maximumModelExchangeEntryBytes } from './limits.js';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [name: string]: JsonValue };

/** Own data only, with both structural and encoded byte limits. Never runs a getter. */
export function capture(value: unknown, limit = maximumModelExchangeEntryBytes): JsonValue {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): JsonValue {
    if (++nodes > 2_000_000 || depth > 64) throw new TypeError('Model exchange value exceeds structural limits');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > limit) throw new RangeError('Model exchange value exceeds byte limit');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || isProxy(item) || ancestors.has(item)) throw new TypeError('Model exchange requires acyclic JSON data');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Model exchange requires plain JSON data');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Model exchange does not accept symbol properties');
    const result: Record<string, JsonValue> | JsonValue[] = array ? [] : {};
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Model exchange does not accept accessors or hidden properties');
      if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) throw new TypeError('Model exchange array contains extra properties');
      bytes += Buffer.byteLength(key);
      if (bytes > limit) throw new RangeError('Model exchange value exceeds byte limit');
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    if (array && Object.keys(descriptors).length !== item.length + 1) throw new TypeError('Model exchange does not accept sparse arrays');
    ancestors.delete(item);
    return Object.freeze(result);
  }
  const result = visit(value, 0);
  if (encodedBytes(result) > limit) throw new RangeError('Model exchange value exceeds byte limit');
  return result;
}

/** Fix only the collection envelope. Each entry is captured and checked independently. */
export function captureSnapshotEnvelope(value: unknown, maximumEntries: number, maximumOrigins: number): Readonly<{ formatVersion: unknown; id: unknown; sequence: unknown; origins: readonly unknown[]; entries: readonly unknown[] }> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError('Invalid model exchange snapshot object');
  const fields = Object.getOwnPropertyDescriptors(value);
  const names = ['formatVersion', 'id', 'sequence', 'origins', 'entries'];
  if (Reflect.ownKeys(fields).length !== names.length || names.some((name) => !Object.hasOwn(fields, name) || !fields[name]!.enumerable || !('value' in fields[name]!))) throw new TypeError('Invalid model exchange snapshot fields');
  const origins = captureSnapshotArray(fields.origins!.value, maximumOrigins);
  const entries = captureSnapshotArray(fields.entries!.value, maximumEntries);
  return Object.freeze({ formatVersion: fields.formatVersion!.value, id: fields.id!.value, sequence: fields.sequence!.value, origins, entries });
}

function captureSnapshotArray(source: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(source) || isProxy(source) || Object.getPrototypeOf(source) !== Array.prototype) throw new TypeError('Invalid model exchange entries array');
  if (source.length > maximum) throw new RangeError('Model exchange snapshot exceeds collection limits');
  if (Reflect.ownKeys(source).length !== source.length + 1) throw new TypeError('Model exchange entries must be a dense data array');
  const entries: unknown[] = [];
  for (let index = 0; index < source.length; index++) {
    const field = Object.getOwnPropertyDescriptor(source, String(index));
    if (!field || !field.enumerable || !('value' in field)) throw new TypeError('Model exchange entries must be a dense data array');
    entries.push(field.value);
  }
  return Object.freeze(entries);
}

export function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Property construction order is not part of an effect's identity. Arrays retain order. */
export function canonical(value: unknown): string {
  const accepted = capture(value);
  function encode(item: JsonValue): string {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item !== null && typeof item === 'object')
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, JsonValue>)[key]!)}`)
        .join(',')}}`;
    return JSON.stringify(item);
  }
  return encode(accepted);
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError('Invalid model exchange object');
  return value as Record<string, unknown>;
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError('Invalid model exchange identity');
  return value;
}
export function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid model exchange revision');
  return value;
}

export function requireExchangeReference(value: unknown): ExchangeReference {
  const item = record(capture(value), ['collection', 'id', 'revision']);
  return Object.freeze({ collection: identity(item.collection), id: identity(item.id), revision: counter(item.revision) });
}
export function requireExchangeOriginReference(value: unknown): ExchangeOriginReference {
  const item = record(capture(value), ['collection', 'id', 'digest']);
  if (typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.digest)) throw new TypeError('Invalid model exchange origin digest');
  return Object.freeze({ collection: identity(item.collection), id: identity(item.id), digest: item.digest });
}
export function requireExchangeOperation(value: unknown): ExchangeOperation {
  const item = record(capture(value), ['parentContextId', 'childContextId', 'position']);
  return Object.freeze({ parentContextId: identity(item.parentContextId), childContextId: identity(item.childContextId), position: identity(item.position) });
}
export function requireExchangeIntakeReceipt(value: unknown): ExchangeIntakeReceipt {
  const item = record(capture(value), ['reference', 'operation']);
  return Object.freeze({ reference: requireExchangeReference(item.reference), operation: requireExchangeOperation(item.operation) });
}
export function requireExchangeFeedbackReceipt(value: unknown): ExchangeFeedbackReceipt {
  const item = record(capture(value), ['reference', 'operation', 'feedbackDigest']);
  if (typeof item.feedbackDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.feedbackDigest)) throw new TypeError('Invalid model exchange feedback digest');
  return Object.freeze({ reference: requireExchangeReference(item.reference), operation: requireExchangeOperation(item.operation), feedbackDigest: item.feedbackDigest });
}
export function feedbackDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonical(requireToolFeedback(capture(value))))
    .digest('hex');
}
