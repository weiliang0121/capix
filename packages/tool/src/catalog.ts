import { utf8ByteLength } from '@weiliang0121/capix-platform/bytes';
import { createSha256 } from '@weiliang0121/capix-platform/hash';
import { isOpaqueObject } from '@weiliang0121/capix-platform/inspection';
import { equalData } from '@weiliang0121/capix-platform/equal';
import { z } from 'zod';
import type { ModelImageContext } from '@weiliang0121/capix-model-exchanges';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import { Callable, type ChildCallable } from '@weiliang0121/capix-structure';
import { readModelToolArguments, requireModelRequest, type ToolResult, type ModelToolCall, type ModelTool, type JsonObject } from '@weiliang0121/capix-model-provider';
import type { ToolMember } from './types.js';
import type { ToolByteBudgets } from './budget.js';
import type { ToolRequestContext } from './context.js';

export interface ToolEntry {
  readonly name: string;
  readonly position: number;
  readonly registration: ToolMember<ChildCallable>;
}
export interface ToolCatalog {
  readonly tools: readonly ModelTool[];
  readonly digest: string;
  readonly policyVersion: string;
  readonly imageContext?: ModelImageContext;
}

/** Read configuration without executing getters. Nodes and schema behavior remain capabilities. */
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isOpaqueObject(value) || Object.getOwnPropertySymbols(value).length) throw new TypeError('Tool configuration must contain data properties');
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Tool configuration must contain enumerable data properties');
    result[key] = descriptor.value;
  }
  return result;
}

export function toolEntries(value: unknown, checkpoint: boolean, maxFeedbackBytes: number): readonly ToolEntry[] {
  const registrations = fields(value);
  const entries: ToolEntry[] = [];
  const seen = new Set<ChildCallable>();
  for (const [name, configuration] of Object.entries(registrations)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name) || ['models', 'completion', '__proto__', 'constructor', 'prototype'].includes(name)) throw new TypeError('Invalid tool member name');
    const item = fields(configuration);
    if (Object.keys(item).some((key) => !['node', 'description', 'input', 'maxOutputBytes', 'maxFeedbackBytes', 'result'].includes(key))) throw new TypeError('Unknown tool member configuration');
    const node = item.node;
    if (isOpaqueObject(node) || !(node instanceof Callable) || (node.kind !== 'node' && node.kind !== 'group')) throw new TypeError('A tool member must be a Node or Group');
    if (seen.has(node)) throw new TypeError('Tool members require distinct structure identities');
    if (checkpoint && !node.checkpoint) throw new TypeError('Recoverable Tool requires checkpoint contracts on its members');
    if (typeof item.description !== 'string' || !item.description.trim()) throw new TypeError('A tool member requires a description');
    const input = item.input as z.ZodType;
    if (!input || isOpaqueObject(input) || typeof input.parse !== 'function') throw new TypeError('A tool member requires an input schema');
    const result = fields(item.result);
    if (Object.keys(result).some((key) => key !== 'succeeded' && key !== 'failed') || typeof result.succeeded !== 'function' || (result.failed !== undefined && typeof result.failed !== 'function')) throw new TypeError('A tool member requires a result mapping');
    const maxOutputBytes = item.maxOutputBytes;
    if (maxOutputBytes !== undefined && (typeof maxOutputBytes !== 'number' || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 8 * 1024 * 1024)) throw new RangeError('Invalid tool output byte limit');
    const feedbackBytes = item.maxFeedbackBytes;
    if (feedbackBytes !== undefined && (typeof feedbackBytes !== 'number' || !Number.isSafeInteger(feedbackBytes) || feedbackBytes < 1 || feedbackBytes > maxFeedbackBytes)) throw new RangeError('Invalid member feedback byte limit');
    const registration: ToolMember<ChildCallable> = Object.freeze({ node, description: item.description, input, ...(feedbackBytes === undefined ? {} : { maxFeedbackBytes: feedbackBytes as number }), ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }), result: Object.freeze({ succeeded: result.succeeded.bind(item.result), ...(result.failed ? { failed: (result.failed as Function).bind(item.result) } : {}) }) }) as ToolMember<ChildCallable>;
    entries.push(Object.freeze({ name, position: entries.length + 1, registration }));
    seen.add(node);
  }
  if (!entries.length || entries.length > 32) throw new RangeError('Tool requires between 1 and 32 members');
  return Object.freeze(entries);
}

function canonical(value: unknown): string {
  if (Object.is(value, -0)) return '-0';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function createToolCatalog(entries: readonly ToolEntry[], policyVersion: string, execution: { readonly capacityPolicy?: 'fail' | 'defer'; readonly maxModelCalls: number; readonly waitMs: number; readonly budgets: ToolByteBudgets; readonly imageContext?: ModelImageContext; readonly requestContext?: ToolRequestContext }): ToolCatalog {
  if (typeof policyVersion !== 'string' || !policyVersion.trim() || policyVersion.length > 512) throw new TypeError('Tool requires an explicit policyVersion');
  const tools = entries.map(({ name, registration }) => {
    const { $schema, ...parameters } = z.toJSONSchema(registration.input, { target: 'draft-7' });
    const schema: JsonObject = z.record(z.string(), z.json()).parse(parameters);
    return freeze({ name, description: registration.description, parameters: schema });
  });
  requireModelRequest({ messages: [{ role: 'user', content: '' }], tools });
  const basis = cloneCheckpointValue({ formatVersion: 1, policyVersion, precheckVersion: 5, execution, tools, members: entries.map(({ name, position, registration }) => ({ name, position, kind: registration.node.kind, maxOutputBytes: registration.maxOutputBytes ?? null, maxFeedbackBytes: registration.maxFeedbackBytes ?? execution.budgets.maxFeedbackBytes, checkpoint: registration.node.checkpoint ? { key: registration.node.checkpoint.key, version: registration.node.checkpoint.version } : null })) });
  return Object.freeze({ policyVersion, ...(execution.imageContext === undefined ? {} : { imageContext: execution.imageContext }), tools: Object.freeze(tools), digest: createSha256().update(canonical(basis)).digestHex() });
}
export type ToolSelection = { readonly kind: 'accepted'; readonly entry: ToolEntry; readonly input: unknown } | { readonly kind: 'rejected'; readonly result: ToolResult };
export function selectTool(entries: readonly ToolEntry[], catalog: ToolCatalog, call: ModelToolCall): ToolSelection {
  const entry = entries.find((item) => item.name === call.name);
  if (!entry) return reject('UNKNOWN_TOOL', 'Requested tool is not registered.');
  let input: unknown;
  try {
    input = readModelToolArguments(call);
  } catch {
    return reject('INVALID_ARGUMENTS', 'Tool arguments must be valid JSON.');
  }
  try {
    const captured = cloneCheckpointValue(input);
    const parsed = entry.registration.input.parse(captured);
    if (!equalData(parsed, captured)) throw new TypeError('Tool input schema must preserve the fixed model arguments');
    return { kind: 'accepted', entry, input: parsed };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return reject('INVALID_ARGUMENTS', 'Tool arguments do not match the registered schema.', schemaIssues(error, catalog.tools.find((tool) => tool.name === entry.name)!.parameters));
  }
}
// Only catalog-declared field names and static diagnostic vocabulary may reach the model.
// Zod messages, values, union details and record/unrecognized keys are intentionally unused.
function schemaIssues(error: z.ZodError, schema: JsonObject) {
  const reasons = new Set(['invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of', 'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom']);
  const expectedTypes = new Set(['string', 'number', 'boolean', 'object', 'array', 'null', 'integer']);
  const issues = error.issues.slice(0, 6).map((issue) => {
    const path: string[] = [];
    let current: unknown = schema;
    for (const segment of issue.path.slice(0, 4)) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) break;
      const node = current as Record<string, unknown>;
      if (typeof segment === 'string' && segment.length <= 64 && node.properties && typeof node.properties === 'object' && Object.hasOwn(node.properties, segment)) {
        path.push(segment);
        current = (node.properties as Record<string, unknown>)[segment];
      } else if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0 && node.type === 'array' && node.items && !Array.isArray(node.items)) {
        path.push('*');
        current = node.items;
      } else break;
    }
    const expected = issue.code === 'invalid_type' && expectedTypes.has(issue.expected) ? issue.expected : undefined;
    return { path, ...(path.length < issue.path.length ? { pathTruncated: true } : {}), reason: reasons.has(issue.code) ? issue.code : 'invalid_value', ...(expected ? { expected } : {}) };
  });
  while (utf8ByteLength(JSON.stringify({ issues, truncated: error.issues.length > issues.length })) > 2048) issues.pop();
  return { issues, truncated: error.issues.length > issues.length };
}
function reject(code: string, message: string, details?: ReturnType<typeof schemaIssues>): ToolSelection {
  return { kind: 'rejected', result: { status: 'error', content: [{ kind: 'text', text: JSON.stringify({ code, message, stage: 'preflight', executed: false, ...details }) }] } };
}
