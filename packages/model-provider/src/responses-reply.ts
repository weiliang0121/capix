import { requireOpenAIResponsesReply } from './contract.js';
import { ModelProtocolIssue, ProviderError } from './error.js';
import { responsesPrefixProof, type ResponsesSource } from './responses-wire.js';
import type { ModelUsage, OpenAIResponsesReply } from './types.js';
import { count, freezeJson, identity, record, shape } from './value.js';

export function responsesEnvelope(): ProviderError {
  return new ProviderError('ENVELOPE', 'Model response is not a supported Responses envelope');
}

/** Responses output provenance is a string on returned items and is omitted on replay. */
export function responsesOutputItem(value: unknown): Record<string, unknown> {
  if (!record(value)) throw responsesEnvelope();
  if (!Object.hasOwn(value, 'created_by')) return value;
  const { created_by, ...item } = value;
  if (typeof created_by !== 'string') throw responsesEnvelope();
  return item;
}

/** A partial argument string is valid at item creation. The caller and function identity are already fixed. */
export function checkResponsesFunctionCall(item: Record<string, unknown>): void {
  shape(item, ['type', 'id', 'name', 'arguments', 'call_id'], ['status', 'async', 'namespace', 'caller']);
  if ((item.async !== undefined && item.async !== false) || item.namespace != null) throw responsesEnvelope();
  if (item.caller != null) {
    shape(item.caller, ['type']);
    if (item.caller.type !== 'direct') throw responsesEnvelope();
  }
  identity(item.call_id);
  if (typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.name) || typeof item.arguments !== 'string') throw responsesEnvelope();
}

function usage(value: unknown): ModelUsage | null {
  if (value == null) return null;
  if (!record(value)) throw responsesEnvelope();
  const { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: totalTokens, input_tokens_details: inputDetails, output_tokens_details: outputDetails } = value;
  if (!count(promptTokens) || !count(completionTokens) || !count(totalTokens) || totalTokens !== promptTokens + completionTokens) throw responsesEnvelope();
  if (inputDetails != null && !record(inputDetails)) throw responsesEnvelope();
  if (outputDetails != null && !record(outputDetails)) throw responsesEnvelope();
  const hit = inputDetails?.cached_tokens;
  const reasoning = outputDetails?.reasoning_tokens;
  const written = inputDetails?.cache_write_tokens;
  if (hit !== undefined && (!count(hit) || hit > promptTokens)) throw responsesEnvelope();
  if (written !== undefined && (!count(written) || written > promptTokens)) throw responsesEnvelope();
  if (reasoning !== undefined && (!count(reasoning) || reasoning > completionTokens)) throw responsesEnvelope();
  return { promptTokens, completionTokens, totalTokens, ...(hit === undefined ? {} : { promptCacheHitTokens: hit }) };
}

function reasoningParts(parts: unknown, type: 'reasoning_text' | 'summary_text'): string[] {
  if (!Array.isArray(parts)) throw responsesEnvelope();
  return parts.map((part) => {
    shape(part, ['type', 'text']);
    if (part.type !== type || typeof part.text !== 'string') throw responsesEnvelope();
    return part.text;
  });
}

/** Only representable assistant items may enter history. Indices refer to the single common output. */
export function acceptResponsesReply(value: unknown, binding: ResponsesSource): OpenAIResponsesReply {
  if (!record(value) || value.object !== 'response') throw responsesEnvelope();
  if (value.status === 'failed') throw new ProviderError('HTTP', 'Responses endpoint reported a failed response');
  if (value.error != null || !Array.isArray(value.output) || (value.status !== 'completed' && value.status !== 'incomplete')) throw responsesEnvelope();
  if (value.store !== undefined && value.store !== (binding.continuation === 'previous-response-id')) throw new ModelProtocolIssue('ENVELOPE', 'store-mismatch');
  if (value.previous_response_id !== undefined && value.previous_response_id !== binding.previousResponseId) throw new ModelProtocolIssue('ENVELOPE', 'predecessor-mismatch');
  const output: unknown[] = [];
  let refused = false;
  const items = value.output.map((raw: unknown) => {
    const item = responsesOutputItem(raw);
    switch (item.type) {
      case 'message': {
        shape(item, ['type', 'id', 'role', 'status', 'content'], ['phase']);
        if (item.role !== 'assistant' || !Array.isArray(item.content)) throw responsesEnvelope();
        const content = item.content.map((part: unknown) => {
          if (!record(part)) throw responsesEnvelope();
          if (part.type === 'refusal') {
            shape(part, ['type', 'refusal']);
            refused = true;
            return { kind: 'refusal', refusal: part.refusal };
          }
          shape(part, ['type', 'text'], ['annotations', 'logprobs']);
          if (part.type !== 'output_text' || [part.annotations, part.logprobs].some((field) => field !== undefined && !(Array.isArray(field) && field.length === 0))) throw responsesEnvelope();
          const index = output.length;
          output.push({ kind: 'text', text: part.text });
          return { kind: 'output_text', index };
        });
        return { kind: 'message', id: item.id, status: item.status, ...(item.phase == null ? {} : { phase: item.phase }), content };
      }
      case 'function_call': {
        checkResponsesFunctionCall(item);
        const index = output.length;
        output.push({ kind: 'tool-call', id: item.call_id, name: item.name, arguments: { encoding: 'json-text', text: item.arguments } });
        return { kind: 'function_call', id: item.id, ...(item.status === undefined ? {} : { status: item.status }), index };
      }
      case 'reasoning': {
        shape(item, ['type', 'id', 'summary'], ['content', 'encrypted_content', 'status']);
        return { kind: 'reasoning', id: item.id, ...(item.status === undefined ? {} : { status: item.status }), summary: reasoningParts(item.summary, 'summary_text'), ...(item.content === undefined ? {} : { content: reasoningParts(item.content, 'reasoning_text') }), ...(item.encrypted_content == null ? {} : { encryptedContent: item.encrypted_content }) };
      }
      default:
        throw responsesEnvelope();
    }
  });
  let termination: OpenAIResponsesReply['termination'];
  if (value.status === 'incomplete') {
    shape(value.incomplete_details, ['reason']);
    if (typeof value.incomplete_details.reason !== 'string') throw responsesEnvelope();
    termination = { kind: 'incomplete', reason: value.incomplete_details.reason };
  } else {
    if (value.incomplete_details != null) throw responsesEnvelope();
    termination = refused ? { kind: 'refused', reason: 'refusal' } : { kind: 'completed', reason: 'completed' };
  }
  const reply = requireOpenAIResponsesReply({ formatVersion: 1, id: value.id, model: value.model, termination, output, usage: usage(value.usage), native: { format: 'openai-responses', version: 1, bindingId: binding.bindingId, model: binding.model, continuation: binding.continuation, previousResponseId: binding.previousResponseId, prefixSha256: binding.prefixSha256, items } });
  return freezeJson({ ...reply, native: { ...reply.native, prefixSha256: responsesPrefixProof(binding.prefixSha256, reply) } });
}
