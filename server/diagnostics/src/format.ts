import { isArray } from 'es-toolkit/compat';
import { isNativeError, isProxy } from 'node:util/types';
import { zipObject } from 'es-toolkit/array';
import { isError, isString, isUndefined } from 'es-toolkit/predicate';
import type { RuntimeErrorDetail, RuntimeErrorValue } from '@capix/contracts';
import { ErrorTraversal, formatLimits } from './traversal.js';
import { formatDetail, formatText } from './detail.js';

const errorFieldNames = ['code', 'message', 'name', 'stack', 'detail', 'cause', 'errors'] as const;
type ErrorFields = Record<(typeof errorFieldNames)[number], unknown>;
// DOMException exposes its native slots as inherited accessors. Only these captured
// platform getters are safe to call; author accessors are never diagnostic work.
const nativeDOMGetters = new Set(typeof DOMException === 'undefined' ? [] : ['name', 'message', 'code'].map((key) => Object.getOwnPropertyDescriptor(DOMException.prototype, key)?.get).filter((get) => get !== undefined));
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const nativeStackFormatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')?.value;

/** Identify the thrown value, then map diagnostics under one shared traversal. */
export function formatError(error: unknown, traversal: ErrorTraversal, depth = 0): RuntimeErrorValue {
  if (!traversal.consume(depth)) return { code: 'ERROR_TRUNCATED', message: '[Truncated: error conversion limit]' };
  if (error === null || typeof error !== 'object') return formatThrownValue(error, traversal, depth);
  if (isProxy(error)) return { code: 'UNREADABLE_ERROR', message: '[Uninspectable thrown object]' };
  if (traversal.contains(error)) return { code: 'CIRCULAR_ERROR', message: '[Circular error reference]' };
  try {
    if (!isNativeError(error) && !isError(error)) return formatThrownValue(error, traversal, depth);
    return traversal.within(error, () => formatFields(readFields(error), traversal, depth));
  } catch {
    return { code: 'UNREADABLE_ERROR', message: '[Uninspectable thrown object]' };
  }
}

function formatThrownValue(value: unknown, traversal: ErrorTraversal, depth: number): RuntimeErrorValue {
  return { code: 'NON_ERROR_THROWN', message: 'A non-Error value was thrown', detail: formatContent(value, traversal, depth + 1) };
}

function readFields(error: object): ErrorFields {
  return zipObject(
    errorFieldNames,
    errorFieldNames.map((key) => readProperty(error, key)),
  );
}

function formatFields(fields: ErrorFields, traversal: ErrorTraversal, depth: number): RuntimeErrorValue {
  return {
    code: isString(fields.code) ? formatText(fields.code) : isArray(fields.errors) ? 'AGGREGATE_ERROR' : 'INTERNAL_ERROR',
    message: isString(fields.message) ? formatText(fields.message) : 'Error message unavailable',
    name: isString(fields.name) ? formatText(fields.name) : 'Error',
    ...(isString(fields.stack) ? { stack: formatText(fields.stack) } : {}),
    ...(isUndefined(fields.detail) ? {} : { detail: formatContent(fields.detail, traversal, depth + 1) }),
    ...(isUndefined(fields.cause) ? {} : { cause: formatError(fields.cause, traversal, depth + 1) }),
    ...(isUndefined(fields.errors) ? {} : { errors: formatMembers(fields.errors, traversal, depth + 1) }),
  };
}

function formatContent(value: unknown, traversal: ErrorTraversal, depth: number): RuntimeErrorDetail {
  return formatDetail(value, traversal, depth, (error, nestedDepth) => formatError(error, traversal, nestedDepth) as unknown as RuntimeErrorDetail);
}

function formatMembers(members: unknown, traversal: ErrorTraversal, depth: number): RuntimeErrorValue[] {
  if (isProxy(members) || !isArray(members)) return [{ code: 'UNREADABLE_ERROR', message: '[Unreadable aggregate members]' }];
  const errors: RuntimeErrorValue[] = [];
  for (let i = 0; i < Math.min(members.length, formatLimits.entries); i++) errors.push(formatError(readProperty(members, String(i)), traversal, depth));
  if (members.length > formatLimits.entries) errors.push({ code: 'ERROR_TRUNCATED', message: '[Truncated: aggregate member limit]' });
  return errors;
}

function readProperty(value: object, key: string): unknown {
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth <= formatLimits.depth; depth++) {
      if (isProxy(current)) return '[Unreadable property]';
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if ('value' in descriptor) return descriptor.value;
        if (descriptor.get && nativeDOMGetters.has(descriptor.get)) return descriptor.get.call(value);
        // V8 exposes the native stack as a lazy accessor. Its formatting can call
        // author code through name/message or Error.prepareStackTrace, so retain
        // stacks only when those inputs still use safe data and the host formatter.
        if (key === 'stack' && descriptor.get && descriptor.get === nativeStackGetter && safeErrorText(value, 'name') && safeErrorText(value, 'message')) {
          const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
          if (formatter && 'value' in formatter && formatter.value === nativeStackFormatter) return descriptor.get.call(value);
        }
        return '[Accessor not evaluated]';
      }
      current = Object.getPrototypeOf(current);
    }
    return current ? '[Truncated: prototype limit]' : undefined;
  } catch {
    return '[Unreadable property]';
  }
}

function safeErrorText(value: object, key: 'name' | 'message'): boolean {
  let current: object | null = value;
  for (let depth = 0; current && depth <= formatLimits.depth; depth++) {
    if (isProxy(current)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return 'value' in descriptor && (typeof descriptor.value === 'string' || descriptor.value === undefined);
    current = Object.getPrototypeOf(current);
  }
  return current === null;
}
