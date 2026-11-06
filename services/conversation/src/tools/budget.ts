import { types } from 'node:util';
import { maximumModelExchangeEntryBytes, type ModelExchangeEntry } from '@capix/model-exchanges';
import { requireModelReply, requireModelRequest, requireToolFeedback, requireToolResult, type ModelReply, type ModelRequest, type ModelRequestInspection, type ToolResult } from '@capix/model-provider';

/** UTF-8 bytes of complete JSON values, including protocol envelopes and call IDs. */
export interface ToolByteBudgets {
  readonly maxReplyBytes: number;
  readonly maxFeedbackBytes: number;
  readonly maxRequestBytes: number;
  readonly maxWireRequestBytes: number;
  readonly maxCollectionBytes: number;
}
export const defaultToolByteBudgets: ToolByteBudgets = Object.freeze({ maxReplyBytes: 64 * 1024, maxFeedbackBytes: 4 * 1024, maxRequestBytes: 2 * 1024 * 1024, maxWireRequestBytes: 2 * 1024 * 1024, maxCollectionBytes: 8 * 1024 * 1024 });
export interface ToolRequestInspection {
  inspectRequest(request: ModelRequest): ModelRequestInspection;
}
export function resolveToolBudgets(configuration: Partial<ToolByteBudgets> = {}): ToolByteBudgets {
  const resolved = { ...defaultToolByteBudgets, ...configuration };
  for (const key of Object.keys(resolved)) {
    if (!(key in defaultToolByteBudgets)) throw new TypeError(`Unknown tool byte budget: ${key}`);
    const value = resolved[key as keyof ToolByteBudgets];
    const ceiling = key === 'maxCollectionBytes' ? 128 * 1024 * 1024 : 2 * 1024 * 1024;
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new RangeError(`Invalid tool byte budget: ${key}`);
  }
  return Object.freeze(resolved);
}
export class ToolBudgetError extends Error {
  constructor(
    readonly code: 'TOOL_REPLY_LIMIT' | 'TOOL_FEEDBACK_LIMIT' | 'TOOL_OUTPUT_LIMIT' | 'TOOL_REQUEST_LIMIT' | 'TOOL_WIRE_REQUEST_LIMIT' | 'TOOL_COLLECTION_LIMIT',
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`${code}: ${bytes} bytes exceeds ${limit}`);
    this.name = 'ToolBudgetError';
  }
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function within(code: ToolBudgetError['code'], value: number, limit: number): void {
  if (value > limit) throw new ToolBudgetError(code, value, limit);
}
export function assertToolReplyBytes(reply: ModelReply, budgets: ToolByteBudgets): ModelReply {
  requireModelReply(reply);
  within('TOOL_REPLY_LIMIT', bytes(reply), budgets.maxReplyBytes);
  return reply;
}
export function assertToolFeedbackBytes(toolCallId: string, result: ToolResult, budgets: ToolByteBudgets): ToolResult {
  if (typeof toolCallId !== 'string' || !toolCallId.trim() || toolCallId.length > 512) throw new TypeError('Tool feedback identity cannot be stored in its exchange');
  requireToolResult(result);
  const feedback = requireToolFeedback({ toolCallId, ...result });
  within('TOOL_FEEDBACK_LIMIT', bytes(feedback), budgets.maxFeedbackBytes);
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
export function assertToolRequestBytes(request: ModelRequest, budgets: ToolByteBudgets, inspection?: ToolRequestInspection, growth = 0): void {
  requireModelRequest(request);
  const measured = inspection?.inspectRequest(request);
  within('TOOL_REQUEST_LIMIT', (measured?.requestBytes ?? bytes(request)) + growth, budgets.maxRequestBytes);
  // growth counts already-encoded feedback JSON. Encoding that JSON in the wire content
  // string at most doubles its bytes; raw text length is deliberately never used here.
  if (measured) within('TOOL_WIRE_REQUEST_LIMIT', measured.wireBytes + 2 * growth, budgets.maxWireRequestBytes);
}

// Entity identities are limited to 512 UTF-16 code units. Worst-case JSON escaping,
// all operation IDs, counters and keys fit these envelopes; actual reply/feedback
// JSON is budgeted separately. These are reservations, not claimed exact sizes.
const newEntryEnvelopeBytes = 20 * 1024;
const feedbackReceiptEnvelopeBytes = 16 * 1024;
export function assertToolCollectionBytes(entries: readonly ModelExchangeEntry[], budgets: ToolByteBudgets, growth = 0): void {
  within('TOOL_COLLECTION_LIMIT', entries.reduce((total, entry) => total + bytes(entry), 0) + growth, budgets.maxCollectionBytes);
}
export function reserveToolReply(entries: readonly ModelExchangeEntry[], budgets: ToolByteBudgets): void {
  const growth = budgets.maxReplyBytes + newEntryEnvelopeBytes;
  within('TOOL_COLLECTION_LIMIT', growth, maximumModelExchangeEntryBytes);
  assertToolCollectionBytes(entries, budgets, growth);
}
export function reserveToolFeedback(entries: readonly ModelExchangeEntry[], current: ModelExchangeEntry, pending: number, budgets: ToolByteBudgets): void {
  const growth = pending * (budgets.maxFeedbackBytes + feedbackReceiptEnvelopeBytes);
  within('TOOL_COLLECTION_LIMIT', bytes(current) + growth, maximumModelExchangeEntryBytes);
  assertToolCollectionBytes(entries, budgets, growth);
}
