import { createSha256 } from '@weiliang0121/capix-platform/hash';
import { requireModelRequest } from '@weiliang0121/capix-model-provider';
import type { ModelExchangeBasis, ModelExchangeOrigin, ModelImageContext } from './types.js';
import { capture, counter, identity, record, type JsonValue } from './value.js';
import { maximumModelExchangeOriginBytes } from './limits.js';

/** Fix the entire source before projecting fields, so capabilities cannot be stripped. */
export function requireModelExchangeBasis(value: unknown): ModelExchangeBasis {
  const item = record(capture(value, maximumModelExchangeOriginBytes), ['request', 'catalog']);
  const request = record(item.request, ['messages', 'toolChoice', 'maxTokens', 'responseFormat', 'temperature', 'stream']);
  const catalog = record(item.catalog, ['tools', 'digest', 'policyVersion', 'imageContext']);
  const imageContext = catalog.imageContext === undefined ? undefined : requireModelImageContext(catalog.imageContext);
  const digest = identity(catalog.digest);
  const policyVersion = identity(catalog.policyVersion);
  if (!Array.isArray(catalog.tools)) throw new TypeError('Model exchange origin requires a tool catalog');
  const validated = requireModelRequest({ ...request, ...(catalog.tools.length === 0 ? {} : { tools: catalog.tools }) });
  return Object.freeze({ request: request as unknown as ModelExchangeBasis['request'], catalog: Object.freeze({ tools: validated.tools ?? Object.freeze([]), digest, policyVersion, ...(imageContext === undefined ? {} : { imageContext }) }) });
}

export function requireModelExchangeOrigin(value: unknown): ModelExchangeOrigin {
  const item = record(capture(value, maximumModelExchangeOriginBytes), ['id', 'sequence', 'digest', 'request', 'catalog']);
  const basis = requireModelExchangeBasis({ request: item.request, catalog: item.catalog });
  const sequence = counter(item.sequence);
  if (sequence === 0 || item.digest !== exchangeOriginDigest(basis)) throw new TypeError('Invalid saved model exchange origin');
  return Object.freeze({ id: identity(item.id), sequence, digest: item.digest as string, ...basis });
}

/** Data has already been captured. Sorting keys preserves construction-order independence. */
export function exchangeOriginDigest(basis: ModelExchangeBasis): string {
  function encode(value: JsonValue): string {
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
    if (value !== null && typeof value === 'object')
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, JsonValue>)[key]!)}`)
        .join(',')}}`;
    // Plain JSON would collapse -0 into 0 and allow different fixed data to share a digest.
    if (typeof value === 'number' && Object.is(value, -0)) return '-0';
    return JSON.stringify(value);
  }
  return createSha256()
    .update(encode(basis as unknown as JsonValue))
    .digestHex();
}

/** Capture policy data before reading it, including for Tool constructor configuration. */
export function requireModelImageContext(value: unknown): ModelImageContext {
  const item = record(capture(value), ['retainLatestToolImages']);
  const count = item.retainLatestToolImages;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || Object.is(count, -0)) throw new TypeError('Image context requires a nonnegative safe integer');
  return Object.freeze({ retainLatestToolImages: count });
}
