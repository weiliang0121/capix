import { isNativeError } from 'node:util/types';
import type { RuntimeErrorDetail, RuntimeErrorValue } from '../../shared/errors.js';
import { ErrorTraversal, formatLimits } from './traversal.js';
import { formatDetail, formatText } from './detail.js';

interface ErrorFields {
  code: unknown;
  message: unknown;
  name: unknown;
  stack: unknown;
  detail: unknown;
  cause: unknown;
  errors: unknown;
}

/** Identify the thrown value, then map diagnostics under one shared traversal traversal. */
export function formatError(error: unknown, traversal: ErrorTraversal, depth = 0): RuntimeErrorValue {
  if (!traversal.consume(depth)) return { code: 'ERROR_TRUNCATED', message: '[Truncated: error conversion limit]' };
  if (typeof error !== 'object' || error === null) return formatThrownValue(error, traversal, depth);
  if (traversal.contains(error)) return { code: 'CIRCULAR_ERROR', message: '[Circular error reference]' };
  try {
    if (!isNativeError(error) && !(error instanceof Error)) return formatThrownValue(error, traversal, depth);
    return traversal.within(error, () => formatFields(readFields(error), traversal, depth));
  } catch {
    return { code: 'UNREADABLE_ERROR', message: '[Uninspectable thrown object]' };
  }
}

function formatThrownValue(value: unknown, traversal: ErrorTraversal, depth: number): RuntimeErrorValue {
  return { code: 'NON_ERROR_THROWN', message: 'A non-Error value was thrown', detail: formatContent(value, traversal, depth + 1) };
}

function readFields(error: object): ErrorFields {
  return {
    code: readProperty(error, 'code'),
    message: readProperty(error, 'message'),
    name: readProperty(error, 'name'),
    stack: readProperty(error, 'stack'),
    detail: readProperty(error, 'detail'),
    cause: readProperty(error, 'cause'),
    errors: readProperty(error, 'errors'),
  };
}

function formatFields(fields: ErrorFields, traversal: ErrorTraversal, depth: number): RuntimeErrorValue {
  return {
    code: typeof fields.code === 'string' ? formatText(fields.code) : Array.isArray(fields.errors) ? 'AGGREGATE_ERROR' : 'INTERNAL_ERROR',
    message: typeof fields.message === 'string' ? formatText(fields.message) : 'Error message unavailable',
    name: typeof fields.name === 'string' ? formatText(fields.name) : 'Error',
    ...(typeof fields.stack === 'string' ? { stack: formatText(fields.stack) } : {}),
    ...(fields.detail === undefined ? {} : { detail: formatContent(fields.detail, traversal, depth + 1) }),
    ...(fields.cause === undefined ? {} : { cause: formatError(fields.cause, traversal, depth + 1) }),
    ...(fields.errors === undefined ? {} : { errors: formatMembers(fields.errors, traversal, depth + 1) }),
  };
}

function formatContent(value: unknown, traversal: ErrorTraversal, depth: number): RuntimeErrorDetail {
  return formatDetail(value, traversal, depth, (error, nestedDepth) => formatError(error, traversal, nestedDepth) as unknown as RuntimeErrorDetail);
}

function formatMembers(members: unknown, traversal: ErrorTraversal, depth: number): RuntimeErrorValue[] {
  if (!Array.isArray(members)) return [{ code: 'UNREADABLE_ERROR', message: '[Unreadable aggregate members]' }];
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
