import { isArray, isFinite } from 'es-toolkit/compat';
import { isNativeError } from 'node:util/types';
import { isBoolean, isDate, isMap, isNull, isNumber, isSet, isString, isSymbol, isUndefined } from 'es-toolkit/predicate';
import type { RuntimeErrorDetail } from '@capix/contracts';
import { ErrorTraversal, formatLimits } from './traversal.js';

type DetailConverter = (value: unknown) => RuntimeErrorDetail;
type NestedErrorConverter = (value: unknown, depth: number) => RuntimeErrorDetail;

/** Describe arbitrary content as detached JSON. Nested errors use the caller's error mapping. */
export function formatDetail(value: unknown, traversal: ErrorTraversal, depth: number, formatNestedError: NestedErrorConverter): RuntimeErrorDetail {
  if (!traversal.consume(depth)) return '[Truncated: error conversion limit]';
  if (value === null || typeof value !== 'object') return formatScalar(value);
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
  if (isNull(value) || isBoolean(value)) return value;
  if (isString(value)) return formatText(value);
  if (isNumber(value)) return isFinite(value) ? value : `[Number: ${value}]`;
  if (isUndefined(value)) return '[Undefined]';
  if (typeof value === 'bigint') return formatText(`[BigInt: ${value}]`);
  if (isSymbol(value)) return formatText(`[Symbol: ${value.description ?? ''}]`);
  return '[Function]';
}

function formatObject(value: object, convert: DetailConverter): RuntimeErrorDetail {
  if (isDate(value)) return formatDate(value);
  if (isMap(value)) return { type: 'Map', entries: formatEntries(Map.prototype.entries.call(value), ([key, item]) => [convert(key), convert(item)]) };
  if (isSet(value)) return { type: 'Set', entries: formatEntries(Set.prototype.values.call(value), convert) };
  if (isArray(value)) return formatArray(value, convert);
  return formatProperties(value, convert);
}

function formatDate(value: Date): RuntimeErrorDetail {
  const time = Date.prototype.getTime.call(value);
  return { type: 'Date', value: isFinite(time) ? new Date(time).toISOString() : '[Invalid Date]' };
}

function formatEntries<Item>(values: Iterable<Item>, convert: (value: Item) => RuntimeErrorDetail): RuntimeErrorDetail[] {
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
