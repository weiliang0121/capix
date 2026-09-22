import { isNativeError } from 'node:util/types';
import type { RuntimeErrorDetail } from '../../shared/errors.js';
import { ErrorTraversal, formatLimits } from './traversal.js';

type DetailConverter = (value: unknown) => RuntimeErrorDetail;
type NestedErrorConverter = (value: unknown, depth: number) => RuntimeErrorDetail;

/** Describe arbitrary content as detached JSON. Nested errors use the caller's error mapping. */
export function formatDetail(value: unknown, traversal: ErrorTraversal, depth: number, formatNestedError: NestedErrorConverter): RuntimeErrorDetail {
  if (!traversal.consume(depth)) return '[Truncated: error conversion limit]';
  if (typeof value !== 'object' || value === null) return formatScalar(value);
  if (traversal.contains(value)) return '[Circular reference]';
  try {
    if (isNativeError(value)) return formatNestedError(value, depth + 1);
    const convert: DetailConverter = (item) => formatDetail(item, traversal, depth + 1, formatNestedError);
    return traversal.within(value, () => formatObject(value, convert));
  } catch {
    return '[Uninspectable value]';
  }
}

export function formatText(value: string): string {
  return value.length > formatLimits.string ? `${value.slice(0, formatLimits.string)}[Truncated: string limit]` : value;
}

function formatScalar(value: unknown): RuntimeErrorDetail {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return formatText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : `[Number: ${value}]`;
  if (typeof value === 'undefined') return '[Undefined]';
  if (typeof value === 'bigint') return formatText(`[BigInt: ${value}]`);
  if (typeof value === 'symbol') return formatText(`[Symbol: ${value.description ?? ''}]`);
  return '[Function]';
}

function formatObject(value: object, convert: DetailConverter): RuntimeErrorDetail {
  if (value instanceof Date) return formatDate(value);
  if (value instanceof Map) return { type: 'Map', entries: formatEntries(Map.prototype.entries.call(value), ([key, item]) => [convert(key), convert(item)]) };
  if (value instanceof Set) return { type: 'Set', entries: formatEntries(Set.prototype.values.call(value), convert) };
  if (Array.isArray(value)) return formatArray(value, convert);
  return formatProperties(value, convert);
}

function formatDate(value: Date): RuntimeErrorDetail {
  const time = Date.prototype.getTime.call(value);
  return { type: 'Date', value: Number.isFinite(time) ? new Date(time).toISOString() : '[Invalid Date]' };
}

function formatEntries<T>(values: Iterable<T>, convert: (value: T) => RuntimeErrorDetail): RuntimeErrorDetail[] {
  const entries: RuntimeErrorDetail[] = [];
  for (const value of values) {
    if (entries.length >= formatLimits.entries) {
      entries.push('[Truncated: entry limit]');
      break;
    }
    entries.push(convert(value));
  }
  return entries;
}

function formatArray(value: unknown[], convert: DetailConverter): RuntimeErrorDetail[] {
  const items: RuntimeErrorDetail[] = [];
  for (let i = 0; i < Math.min(value.length, formatLimits.entries); i++) items.push(convert(readOwnValue(value, String(i))));
  if (value.length > formatLimits.entries) items.push('[Truncated: entry limit]');
  return items;
}

function formatProperties(value: object, convert: DetailConverter): RuntimeErrorDetail {
  const result: { [key: string]: RuntimeErrorDetail } = Object.create(null);
  const keys = Object.keys(value);
  for (const key of keys.slice(0, formatLimits.entries)) result[key] = convert(readOwnValue(value, key));
  if (keys.length > formatLimits.entries) result['[Truncated]'] = 'Entry limit reached';
  return result;
}

function readOwnValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : descriptor ? '[Accessor not evaluated]' : undefined;
}
