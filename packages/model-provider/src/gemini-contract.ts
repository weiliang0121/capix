import { createHash } from 'node:crypto';
import type { ReplyFields } from './native-reply.js';
import type { ModelReply } from './types.js';
import { identity, record, shape } from './value.js';

const refusals = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'ESCALATION', 'PUP_LIMITED_DISABLED']);

export function geminiTerminationKind(reason: string, promptBlocked: boolean): ModelReply['termination']['kind'] {
  if (promptBlocked || refusals.has(reason)) return 'refused';
  return reason === 'STOP' ? 'completed' : 'incomplete';
}

/** Local feedback identity is independent of an optional upstream functionCall.id. */
export function geminiCallId(replyId: string, partIndex: number): string {
  return (
    'gemini-call-' +
    createHash('sha256')
      .update(JSON.stringify([replyId, partIndex]))
      .digest('hex')
  );
}

/** Object key order can change during persistence. Signatures stay attached to their original parts. */
export function geminiPartsProof(parts: readonly unknown[], output: readonly unknown[]): string {
  const material = JSON.stringify([parts, output], (_key, value: unknown) =>
    record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  return createHash('sha256').update('capix.gemini.signed-parts.v1\n').update(material).digest('hex');
}

export function checkGeminiReply(native: Record<string, unknown>, { id, model, output, termination, usage }: ReplyFields): void {
  shape(native, ['format', 'version', 'bindingId', 'model', 'parts'], ['partsSha256', 'promptBlocked', 'idSource', 'modelSource']);
  for (const field of [native.bindingId, native.model]) {
    identity(field);
    if (!field.trim()) throw new TypeError('Empty Gemini binding');
  }
  if (native.idSource !== undefined && (native.idSource !== 'local' || !/^gemini-reply-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))) throw new TypeError('Invalid Gemini local reply identity');
  if (native.modelSource !== undefined && (native.modelSource !== 'configured' || model !== native.model)) throw new TypeError('Invalid Gemini configured model fallback');
  if (!Array.isArray(native.parts)) throw new TypeError('Invalid Gemini parts');
  if (native.promptBlocked !== undefined && (native.promptBlocked !== true || native.parts.length || termination.reason === 'BLOCK_REASON_UNSPECIFIED')) throw new TypeError('Invalid Gemini prompt block');
  if (termination.kind !== geminiTerminationKind(termination.reason, native.promptBlocked === true) || termination.reason === 'FINISH_REASON_UNSPECIFIED') throw new TypeError('Invalid Gemini termination');
  if (usage && (usage.totalTokens !== usage.promptTokens + usage.completionTokens || usage.promptCacheMissTokens !== undefined || usage.promptCacheWriteTokens !== undefined)) throw new TypeError('Invalid Gemini usage counts');
  let next = 0;
  let signed = false;
  const wireIds = new Set<string>();
  for (const [position, part] of native.parts.entries()) {
    if (!record(part)) throw new TypeError('Invalid Gemini part');
    if (part.thoughtSignature !== undefined) {
      if (typeof part.thoughtSignature !== 'string' || !part.thoughtSignature.trim()) throw new TypeError('Invalid Gemini thought signature');
      signed = true;
    }
    switch (part.kind) {
      case 'output': {
        shape(part, ['kind', 'index'], ['thoughtSignature', 'thought', 'wireId', 'omittedArgs']);
        const item = output[next];
        if (part.index !== next++ || !item || (part.thought !== undefined && part.thought !== false)) throw new TypeError('Invalid Gemini output reference');
        if (item.kind === 'tool-call') {
          if (item.id !== geminiCallId(id, position)) throw new TypeError('Invalid Gemini feedback slot identity');
          if (part.omittedArgs !== undefined && (part.omittedArgs !== true || item.arguments.encoding !== 'json-value' || Object.keys(item.arguments.value).length)) throw new TypeError('Invalid Gemini omitted args');
          if (part.wireId !== undefined) {
            identity(part.wireId);
            if (wireIds.has(part.wireId)) throw new TypeError('Duplicate Gemini wire call id');
            wireIds.add(part.wireId);
          }
        } else if (part.wireId !== undefined || part.omittedArgs !== undefined) throw new TypeError('Invalid Gemini text reference');
        break;
      }
      case 'thought':
        shape(part, ['kind', 'text'], ['thoughtSignature']);
        if (typeof part.text !== 'string') throw new TypeError('Invalid Gemini thought text');
        break;
      case 'signature':
        shape(part, ['kind', 'thoughtSignature'], ['thought']);
        if (part.thought !== undefined && typeof part.thought !== 'boolean') throw new TypeError('Invalid Gemini thought marker');
        break;
      default:
        throw new TypeError('Unknown Gemini part');
    }
  }
  if (next !== output.length) throw new TypeError('Incomplete Gemini output references');
  if (signed ? native.partsSha256 !== geminiPartsProof(native.parts, output) : native.partsSha256 !== undefined) throw new TypeError('Invalid Gemini signed parts');
}
