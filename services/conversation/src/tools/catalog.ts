import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import type { ToolResult, ModelRequest, JsonObject } from '@weiliang0121/capix-model-provider';
import type { ToolEntry } from './registration.js';
import { parseToolInput } from './registration.js';

export interface ToolCatalog {
  readonly digest: string;
  readonly tools: NonNullable<ModelRequest['tools']>;
  readonly policyVersion: string;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
export function createToolCatalog(entries: readonly ToolEntry[], policyVersion: string): ToolCatalog {
  if (typeof policyVersion !== 'string' || !policyVersion.trim()) throw new TypeError('ToolLoop requires an explicit nonempty policyVersion');
  const tools = entries.map(({ name, registration }) => {
    const { $schema, ...parameters } = z.toJSONSchema(registration.input, { target: 'draft-7' });
    const schema: JsonObject = z.record(z.string(), z.json()).parse(parameters);
    return freeze({ name, description: registration.description, parameters: schema });
  });
  const basis = cloneCheckpointValue({ formatVersion: 2, policyVersion, precheckVersion: 1, tools, members: entries.map(({ name, position, registration }) => ({ name, position, kind: registration.node.kind, maxOutputBytes: registration.maxOutputBytes ?? null, checkpoint: registration.node.checkpoint ? { key: registration.node.checkpoint.key, version: registration.node.checkpoint.version } : null })) });
  return Object.freeze({ policyVersion, tools: Object.freeze(tools), digest: createHash('sha256').update(canonical(basis)).digest('hex') });
}
export type ToolSelection = { readonly kind: 'accepted'; readonly entry: ToolEntry; readonly input: unknown } | { readonly kind: 'rejected'; readonly result: ToolResult };
export function selectTool(entries: readonly ToolEntry[], call: { readonly name: string; readonly arguments: { readonly encoding: 'json-text'; readonly text: string } }): ToolSelection {
  const entry = entries.find((item) => item.name === call.name);
  if (!entry) return reject('UNKNOWN_TOOL', 'Requested tool is not registered.');
  let input: unknown;
  try {
    input = JSON.parse(call.arguments.text);
  } catch {
    return reject('INVALID_ARGUMENTS', 'Tool arguments must be valid JSON.');
  }
  try {
    return { kind: 'accepted', entry, input: parseToolInput(entry.registration, cloneCheckpointValue(input)) };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return reject('INVALID_ARGUMENTS', 'Tool arguments do not match the registered schema.');
  }
}
function reject(code: string, message: string): ToolSelection {
  return { kind: 'rejected', result: { status: 'error', content: [{ kind: 'text', text: JSON.stringify({ code, message }) }] } };
}

function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
