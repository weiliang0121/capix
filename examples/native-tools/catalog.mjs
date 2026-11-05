import { createHash } from 'node:crypto';
import { z } from 'zod';
import { acceptFeedback, resultSchema } from './protocol.mjs';
import { canonical, fixed } from './value.mjs';

const memberSchema = z.strictObject({ position: z.number().int().nonnegative(), contract: z.string().min(1), version: z.number().int().positive() });
const entrySchema = z.strictObject({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u), description: z.string().min(1), schema: z.record(z.string(), z.unknown()), member: memberSchema });
const snapshotSchema = z.strictObject({ version: z.literal(1), precheckVersion: z.literal(1), policyVersion: z.union([z.string().min(1), z.number().int().positive()]), entries: z.array(entrySchema).min(1).max(32) });
const catalogSchema = z.strictObject({ snapshot: snapshotSchema, digest: z.string().regex(/^[a-f0-9]{64}$/u) });
// Only identities created here are trusted. Mutable/deserialized objects never
// become cache keys; callers receive a new deeply frozen authenticated catalog.
const certified = new WeakMap();

/** Immutable model-facing catalog plus exact local dispatch positions and policy version. */
export function createCatalog(entries, { policyVersion = 1 } = {}) {
  const snapshot = snapshotSchema.parse(fixed({ version: 1, precheckVersion: 1, policyVersion, entries }));
  if (new Set(snapshot.entries.map((entry) => entry.name)).size !== snapshot.entries.length) throw new TypeError('Duplicate tool name');
  if (new Set(snapshot.entries.map((entry) => entry.member.position)).size !== snapshot.entries.length) throw new TypeError('Duplicate tool member position');
  for (const entry of snapshot.entries) checkSchema(entry.schema);
  const catalog = Object.freeze({ snapshot: fixed(snapshot), digest: createHash('sha256').update(canonical(snapshot)).digest('hex') });
  certified.set(catalog, new Map(catalog.snapshot.entries.map((entry) => [entry.name, entry])));
  return catalog;
}

export function validateCatalog(expected, actual) {
  const prior = authenticate(expected);
  const accepted = authenticate(actual);
  if (prior.digest !== accepted.digest || canonical(prior.snapshot) !== canonical(accepted.snapshot)) throw new TypeError('Tool catalog changed across recovery');
  return accepted;
}

function authenticate(value) {
  if (certified.has(value)) return value;
  const candidate = catalogSchema.parse(fixed(value));
  const accepted = createCatalog(candidate.snapshot.entries, { policyVersion: candidate.snapshot.policyVersion });
  if (accepted.digest !== candidate.digest || canonical(accepted.snapshot) !== canonical(candidate.snapshot)) throw new TypeError('Tool catalog changed across recovery');
  return accepted;
}

/** This fixture supports object inputs with scalar fields, and rejects unsupported Schema. */
function checkSchema(schema) {
  const value = z.strictObject({ type: z.literal('object'), properties: z.record(z.string(), z.strictObject({ type: z.enum(['string', 'number', 'integer', 'boolean']), description: z.string().optional() })), required: z.array(z.string()), additionalProperties: z.literal(false) }).parse(schema);
  if (new Set(value.required).size !== value.required.length || value.required.some((key) => !Object.hasOwn(value.properties, key))) throw new TypeError('Invalid required tool fields');
}

function matches(schema, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  if (schema.required.some((key) => !Object.hasOwn(input, key))) return false;
  return Object.entries(input).every(([key, value]) => {
    const type = schema.properties[key]?.type;
    return type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type !== undefined && typeof value === type;
  });
}

/** Rejections are loop policy, not fabricated failed child invocations. */
export function precheck(catalog, call) {
  const accepted = authenticate(catalog);
  call = fixed(call);
  if (call.kind !== 'tool-call') throw new TypeError('Tool precheck requires a tool-call item');
  const entry = certified.get(accepted).get(call.name);
  if (!entry) return rejection(call.id, 'UNKNOWN_TOOL', 'Requested tool is not registered.');
  if (call.arguments.encoding !== 'json-text') throw new TypeError('Unsupported tool argument encoding');
  let input;
  try {
    input = fixed(JSON.parse(call.arguments.text));
  } catch {
    return rejection(call.id, 'INVALID_ARGUMENTS', 'Tool arguments must be valid JSON.');
  }
  if (!matches(entry.schema, input)) return rejection(call.id, 'INVALID_ARGUMENTS', 'Tool arguments do not match the registered schema.');
  return { kind: 'accepted', name: entry.name, input };
}

export function rejection(id, code, message) {
  return { kind: 'rejected', feedback: acceptFeedback(id, { status: 'error', content: [{ kind: 'text', text: JSON.stringify({ code, message }) }] }) };
}

/**
 * Typed tool registration consumed by the loop; it creates no execution entity.
 * Runtime still invokes the registered Node/Group normally.
 * Result mappings must be side-effect-free and determined only by their input.
 * A Promise is allowed, but an unaccepted successful delivery may be mapped again
 * during restoration; external I/O belongs in the tool, not in these callbacks.
 * @template {import('@capix/contracts').ChildContract} D
 * @param {D} node
 * @param {{ description: string, input: import('zod').ZodType<import('@capix/contracts').CallableInput<NoInfer<D>>>, result: { succeeded: (value: import('@capix/contracts').CallableOutput<NoInfer<D>>) => import('zod').infer<typeof resultSchema> | Promise<import('zod').infer<typeof resultSchema>>, failed?: (failure: unknown) => import('zod').infer<typeof resultSchema> | Promise<import('zod').infer<typeof resultSchema>> } }} options
 */
export function tool(node, options) {
  if (!node || !['node', 'group'].includes(node.kind)) throw new TypeError('A tool requires an ordinary Node or Group');
  if (!options || typeof options.description !== 'string' || typeof options.input?.parse !== 'function' || typeof options.result?.succeeded !== 'function') throw new TypeError('Tool input and result contracts are required');
  if (Object.keys(options).some((key) => !['description', 'input', 'result'].includes(key)) || Object.keys(options.result).some((key) => !['succeeded', 'failed'].includes(key)) || (options.result.failed !== undefined && typeof options.result.failed !== 'function')) throw new TypeError('Unsupported tool configuration');
  return Object.freeze({ node, description: options.description, input: options.input, result: Object.freeze({ succeeded: options.result.succeeded, ...(options.result.failed === undefined ? {} : { failed: options.result.failed }) }) });
}
