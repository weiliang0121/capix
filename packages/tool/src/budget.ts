import { types } from 'node:util';
import { maximumModelExchangeEntryBytes, type ModelExchangeEntry, type ModelExchangeOrigin } from '@weiliang0121/capix-model-exchanges';
import { assertModelContinuation, maximumModelExchangeBytes, maximumModelRequestBytes, maximumModelWireRequestBytes, requireModelExchange, requireModelReply, requireModelRequest, requireToolFeedback, requireToolResult, type ModelExchange, type ModelReply, type ModelRequest, type ModelRequestInspection, type ModelRequestReservation, type ToolResult } from '@weiliang0121/capix-model-provider';

/** UTF-8 bytes of complete JSON values, including protocol envelopes and call IDs. */
export interface ToolByteBudgets {
  readonly maxReplyBytes: number;
  readonly maxFeedbackBytes: number;
  readonly maxRequestBytes: number;
  /** Optional bound on the actual provider wire body; requires host request inspection. */
  readonly maxWireRequestBytes?: number;
  readonly maxCollectionBytes: number;
}
export const defaultToolByteBudgets: ToolByteBudgets = Object.freeze({ maxReplyBytes: 64 * 1024, maxFeedbackBytes: 4 * 1024, maxRequestBytes: 2 * 1024 * 1024, maxCollectionBytes: 8 * 1024 * 1024 });
export interface ToolRequestInspection {
  inspectRequest(request: ModelRequest): ModelRequestInspection;
  reserveWireBytes?(request: ModelRequest, reservation: ModelRequestReservation): number;
}
export function resolveToolBudgets(configuration: Partial<ToolByteBudgets> = {}): ToolByteBudgets {
  const resolved = { ...defaultToolByteBudgets, ...configuration };
  for (const key of Object.keys(resolved)) {
    if (key !== 'maxWireRequestBytes' && !Object.hasOwn(defaultToolByteBudgets, key)) throw new TypeError(`Unknown tool byte budget: ${key}`);
    const value = resolved[key as keyof ToolByteBudgets];
    if (key === 'maxWireRequestBytes' && value === undefined) continue;
    const ceiling = key === 'maxCollectionBytes' ? 128 * 1024 * 1024 : key === 'maxRequestBytes' ? maximumModelRequestBytes : key === 'maxWireRequestBytes' ? maximumModelWireRequestBytes : 2 * 1024 * 1024;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new RangeError(`Invalid tool byte budget: ${key}`);
  }
  if (resolved.maxWireRequestBytes === undefined) delete resolved.maxWireRequestBytes;
  return Object.freeze(resolved);
}
export class ToolBudgetError extends Error {
  constructor(
    readonly code: 'TOOL_REPLY_LIMIT' | 'TOOL_FEEDBACK_LIMIT' | 'TOOL_OUTPUT_LIMIT' | 'TOOL_CONTEXT_LIMIT' | 'TOOL_REQUEST_LIMIT' | 'TOOL_WIRE_REQUEST_LIMIT' | 'TOOL_EXCHANGE_LIMIT' | 'TOOL_COLLECTION_LIMIT',
    readonly bytes: number,
    readonly limit: number,
    readonly phase: 'actual' | 'reserved' = 'actual',
  ) {
    super(`${code}: ${bytes} bytes exceeds ${limit}`);
    this.name = 'ToolBudgetError';
  }
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function within(code: ToolBudgetError['code'], value: number, limit: number, phase: ToolBudgetError['phase'] = 'actual'): void {
  if (value > limit) throw new ToolBudgetError(code, value, limit, phase);
}
export function assertToolReplyBytes(reply: ModelReply, budgets: Pick<ToolByteBudgets, 'maxReplyBytes'>): ModelReply {
  requireModelReply(reply);
  within('TOOL_REPLY_LIMIT', bytes(reply), budgets.maxReplyBytes);
  return reply;
}
export function assertToolFeedbackBytes(toolCallId: string, result: ToolResult, budgets: Pick<ToolByteBudgets, 'maxFeedbackBytes'>, phase: ToolBudgetError['phase'] = 'actual'): ToolResult {
  if (typeof toolCallId !== 'string' || !toolCallId.trim() || toolCallId.length > 512) throw new TypeError('Tool feedback identity cannot be stored in its exchange');
  requireToolResult(result);
  const feedback = requireToolFeedback({ toolCallId, ...result });
  within('TOOL_FEEDBACK_LIMIT', bytes(feedback), budgets.maxFeedbackBytes, phase);
  return result;
}
/** Tool implementations call this before their own checkpoint/output. The parent check is later. */
export function assertToolOutputBytes<Value>(value: Value, limit: number): Value {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) throw new RangeError('Invalid tool output byte limit');
  const ancestors = new Set<object>();
  let total = 0;
  let visited = 0;
  const add = (amount: number) => {
    total += amount;
    within('TOOL_OUTPUT_LIMIT', total, limit);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++visited > 100_000 || depth > 64) throw new TypeError('Tool output exceeds JSON structure limits');
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return add(bytes(item));
    if (typeof item === 'string') {
      // Reject a known lower bound before allocating a potentially much larger encoded string.
      within('TOOL_OUTPUT_LIMIT', total + Buffer.byteLength(item), limit);
      return add(bytes(item));
    }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) throw new TypeError('Tool output must be finite acyclic JSON');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Tool output must contain plain JSON objects');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (array && keys.length !== item.length + 1) throw new TypeError('Tool output arrays must be dense');
    const count = keys.length - (array ? 1 : 0);
    add(2 + Math.max(0, count - 1));
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('Tool output cannot contain symbols');
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Tool output cannot contain accessors or hidden fields');
      if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) throw new TypeError('Tool output arrays cannot have extra fields');
      if (!array) add(bytes(key) + 1);
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return value;
}
export interface ToolCapacityReason {
  readonly code: 'TOOL_REQUEST_LIMIT' | 'TOOL_WIRE_REQUEST_LIMIT' | 'TOOL_EXCHANGE_LIMIT';
  readonly bytes: number;
  readonly limit: number;
  readonly phase: 'reserved';
}
/** A closed exchange remains bounded even when the assembled request is larger. */
export function assertToolExchangeBytes(exchange: ModelExchange, growth = 0, defer = false): ToolCapacityReason | undefined {
  requireModelExchange(exchange);
  if (!Number.isSafeInteger(growth) || growth < 0) throw new RangeError('Invalid tool exchange byte reservation');
  const total = bytes(exchange) + growth;
  if (total <= maximumModelExchangeBytes) return undefined;
  if (defer && growth > 0) return Object.freeze({ code: 'TOOL_EXCHANGE_LIMIT', bytes: total, limit: maximumModelExchangeBytes, phase: 'reserved' });
  throw new ToolBudgetError('TOOL_EXCHANGE_LIMIT', total, maximumModelExchangeBytes, growth > 0 ? 'reserved' : 'actual');
}
export function assertToolHistoricalRequest(request: ModelRequest, budgets: ToolByteBudgets): void {
  requireModelRequest(request);
  within('TOOL_REQUEST_LIMIT', bytes(request), budgets.maxRequestBytes);
}
export function assertToolRequestBytes(request: ModelRequest, budgets: ToolByteBudgets, inspection?: ToolRequestInspection, projection?: { readonly growth: number; readonly additionalNodes: number; readonly reservation: ModelRequestReservation; readonly defer?: boolean }, expectedCapacity?: Pick<ToolCapacityReason, 'code' | 'limit'>): ToolCapacityReason | undefined {
  const { growth = 0, reservation, defer } = projection ?? {};
  assertModelContinuation(request, reservation, projection?.additionalNodes ?? 0);
  if (budgets.maxWireRequestBytes !== undefined && !inspection) throw new TypeError('An explicit tool wire request budget requires host request inspection');
  const measured = inspection?.inspectRequest(request);
  if (measured && typeof measured === 'object' && 'then' in measured) {
    void Promise.resolve(measured).catch(() => undefined);
    throw new TypeError('Tool request inspection must be synchronous');
  }
  if (inspection && (!measured || typeof measured !== 'object' || !Number.isSafeInteger(measured.requestBytes) || measured.requestBytes < 0 || !Number.isSafeInteger(measured.wireBytes) || measured.wireBytes < 0)) throw new TypeError('Tool request inspection must synchronously return finite byte counts');
  const providerLimits = measured?.limits;
  if (providerLimits !== undefined) {
    if (!providerLimits || typeof providerLimits !== 'object' || Array.isArray(providerLimits) || types.isProxy(providerLimits)) throw new TypeError('Tool provider limits must be fixed byte budgets');
    const fields = Object.getOwnPropertyDescriptors(providerLimits);
    if (Reflect.ownKeys(fields).length !== 2 || ['maxRequestBytes', 'maxWireRequestBytes'].some((key) => !fields[key] || !fields[key]!.enumerable || !('value' in fields[key]!) || !Number.isSafeInteger(fields[key]!.value) || fields[key]!.value < 1)) throw new TypeError('Tool provider limits must contain positive request and wire budgets');
  }
  const requestLimit = Math.min(budgets.maxRequestBytes, providerLimits?.maxRequestBytes ?? maximumModelRequestBytes);
  const wireLimit = budgets.maxWireRequestBytes === undefined && providerLimits === undefined ? undefined : Math.min(budgets.maxWireRequestBytes ?? maximumModelWireRequestBytes, providerLimits?.maxWireRequestBytes ?? maximumModelWireRequestBytes);
  // A resumed decision must still match the effective host/provider budget.
  // The saved fact alone cannot authenticate a lower transport limit.
  if (expectedCapacity && expectedCapacity.limit !== (expectedCapacity.code === 'TOOL_REQUEST_LIMIT' ? requestLimit : expectedCapacity.code === 'TOOL_WIRE_REQUEST_LIMIT' ? wireLimit : maximumModelExchangeBytes)) throw new Error('Saved capacity decision differs from the effective request budget');
  if (!Number.isSafeInteger(growth) || growth < 0) throw new RangeError('Invalid tool request byte reservation');
  const phase = growth > 0 || reservation?.mutableContext || (reservation?.feedback.length ?? 0) > 0 ? 'reserved' : 'actual';
  const compare = (code: ToolCapacityReason['code'], value: number, limit: number): ToolCapacityReason | undefined => {
    if (value <= limit) return undefined;
    if (defer && phase === 'reserved') return Object.freeze({ code, bytes: value, limit, phase });
    throw new ToolBudgetError(code, value, limit, phase);
  };
  let wireBytes = measured?.wireBytes;
  if (wireBytes !== undefined && wireLimit !== undefined && phase === 'reserved') {
    if (!reservation || typeof inspection?.reserveWireBytes !== 'function') throw new TypeError('A tool wire budget with pending feedback or context requires reserveWireBytes');
    const upper = inspection.reserveWireBytes(request, reservation);
    if (types.isPromise(upper)) void Promise.prototype.then.call(upper, undefined, () => undefined);
    if (!Number.isSafeInteger(upper) || upper < wireBytes) throw new TypeError('Tool wire reservation must synchronously bound the complete inspected body');
    wireBytes = upper;
  }
  const requestFailure = compare('TOOL_REQUEST_LIMIT', Math.max(measured?.requestBytes ?? 0, bytes(request)) + growth, requestLimit);
  if (requestFailure) return requestFailure;
  if (wireBytes !== undefined && wireLimit !== undefined) return compare('TOOL_WIRE_REQUEST_LIMIT', wireBytes, wireLimit);
  return undefined;
}

// Entity identities are limited to 512 UTF-16 code units. Worst-case JSON escaping,
// all operation IDs, counters and keys fit these envelopes; actual reply/feedback
// JSON is budgeted separately. These are reservations, not claimed exact sizes.
const newEntryEnvelopeBytes = 20 * 1024;
const feedbackReceiptEnvelopeBytes = 16 * 1024;
export function assertToolCollectionBytes(entries: readonly ModelExchangeEntry[], budgets: ToolByteBudgets, growth = 0, origins: readonly ModelExchangeOrigin[] = []): void {
  within('TOOL_COLLECTION_LIMIT', entries.reduce((total, entry) => total + bytes(entry), 0) + origins.reduce((total, origin) => total + bytes(origin), 0) + growth, budgets.maxCollectionBytes, growth > 0 ? 'reserved' : 'actual');
}
export function reserveToolReply(entries: readonly ModelExchangeEntry[], budgets: ToolByteBudgets, origins: readonly ModelExchangeOrigin[] = []): void {
  const growth = budgets.maxReplyBytes + newEntryEnvelopeBytes;
  within('TOOL_COLLECTION_LIMIT', growth, maximumModelExchangeEntryBytes, 'reserved');
  assertToolCollectionBytes(entries, budgets, growth, origins);
}
export function reserveToolFeedback(entries: readonly ModelExchangeEntry[], current: ModelExchangeEntry, pending: readonly number[], budgets: ToolByteBudgets, origins: readonly ModelExchangeOrigin[] = []): void {
  const growth = pending.reduce((total, limit) => total + limit + feedbackReceiptEnvelopeBytes, 0);
  within('TOOL_COLLECTION_LIMIT', bytes(current) + growth, maximumModelExchangeEntryBytes, 'reserved');
  assertToolCollectionBytes(entries, budgets, growth, origins);
}
