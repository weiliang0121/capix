import { isObjectLike } from '../value/object.js';
import { isArray } from 'es-toolkit/compat';
import { isNativeError } from 'node:util/types';
import { zipObject } from 'es-toolkit/array';
import { isError, isString, isUndefined } from 'es-toolkit/predicate';
import type { RuntimeErrorDetail, RuntimeErrorValue } from '@capix/protocol';
import { ErrorTraversal, formatLimits } from './traversal.js';
import { formatDetail, formatText } from './detail.js';

const errorFieldNames = ['code', 'message', 'name', 'stack', 'detail', 'cause', 'errors'] as const;
type ErrorFields = Record<(typeof errorFieldNames)[number], unknown>;

/** Identify the thrown value, then map diagnostics under one shared traversal. */
export function formatError(error: unknown, traversal: ErrorTraversal, depth = 0): RuntimeErrorValue {
  if (!traversal.consume(depth)) return { code: 'ERROR_TRUNCATED', message: '[Truncated: error conversion limit]' };
  if (!isObjectLike(error)) return formatThrownValue(error, traversal, depth);
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
  if (!isArray(members)) return [{ code: 'UNREADABLE_ERROR', message: '[Unreadable aggregate members]' }];
  const errors: RuntimeErrorValue[] = [];
  for (let i = 0; i < Math.min(members.length, formatLimits.entries); i++) errors.push(formatError(readProperty(members, String(i)), traversal, depth));
  if (members.length > formatLimits.entries) errors.push({ code: 'ERROR_TRUNCATED', message: '[Truncated: aggregate member limit]' });
  return errors;
}

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return '[Unreadable property]';
  }
}
