// These are service diagnostic fields, not a whitelist for execution or resource authorization.
const identifiers = new Set(['id', 'contract', 'transcriptId', 'memoriesId', 'memoryId', 'model', 'finishReason', 'role', 'kind', 'status', 'action', 'scope', 'version', 'source']);

/** Keep causal identifiers and sizes; formal content remains in Transcript / Memories.
 * Arrays are counted rather than copied at every parent boundary. The bounded traversal
 * also covers custom answer members without assuming that all outputs have one shape.
 */
export function describeConversationValue(value: unknown): unknown {
  // Five levels retain materials.basis.sources.{messages,memories} identities and
  // versions. A shared field budget bounds branching even for custom members.
  const budget = { remaining: 128 };
  return describeValue(value, '', 0, budget);
}

function describeValue(value: unknown, field: string, depth: number, budget: { remaining: number }): unknown {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { type: 'number', value: String(value) };
  if (typeof value === 'string') return identifiers.has(field) && value.length <= 256 ? value : { characters: value.length };
  if (Array.isArray(value)) return { items: value.length };
  if (typeof value !== 'object') return { type: typeof value };
  const keys = Object.keys(value);
  if (depth >= 5 || budget.remaining === 0) return { fields: keys.length };
  const summary: Record<string, unknown> = {};
  let included = 0;
  for (const key of keys.slice(0, 16)) {
    if (budget.remaining === 0) break;
    budget.remaining--;
    included++;
    const property = Object.getOwnPropertyDescriptor(value, key);
    // An observation must not execute a business getter just to obtain a description.
    const described = property && 'value' in property ? describeValue(property.value, key, depth + 1, budget) : { type: 'accessor' };
    Object.defineProperty(summary, key, { value: described, enumerable: true });
  }
  return keys.length > included ? { fields: summary, omittedFields: keys.length - included } : summary;
}
