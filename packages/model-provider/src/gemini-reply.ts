import { randomUUID } from '@weiliang0121/capix-platform/identity';
import { requireGeminiGenerateContentReply } from './contract.js';
import { ModelProtocolIssue, ProviderError } from './error.js';
import { geminiCallId, geminiPartsProof, geminiTerminationKind } from './gemini-contract.js';
import type { GeminiSource } from './gemini-wire.js';
import type { GeminiGenerateContentReply, ModelUsage } from './types.js';
import { count, freezeJson, identity, record, requireJson, shape } from './value.js';

function geminiIdentity(value: unknown, reason: 'invalid-response-id' | 'invalid-model' | 'invalid-candidate' | 'invalid-part' | 'invalid-envelope'): asserts value is string {
  try {
    identity(value);
  } catch {
    throw new ModelProtocolIssue('ENVELOPE', reason);
  }
}

function geminiShape(value: unknown, required: readonly string[], optional: readonly string[], reason: 'invalid-candidate' | 'invalid-part'): asserts value is Record<string, unknown> {
  try {
    shape(value, required, optional);
  } catch {
    throw new ModelProtocolIssue('ENVELOPE', reason);
  }
}

function usage(value: unknown): ModelUsage | null {
  if (value === undefined) return null;
  if (!record(value)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-usage');
  const { promptTokenCount: prompt, candidatesTokenCount: candidates, cachedContentTokenCount: hit, thoughtsTokenCount: thoughts, toolUsePromptTokenCount: toolPrompt, totalTokenCount: totalTokens } = value;
  for (const counter of [prompt, candidates, hit, thoughts, toolPrompt, totalTokens]) if (counter !== undefined && !count(counter)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-usage');
  if (typeof prompt === 'number' && typeof hit === 'number' && hit > prompt) throw new ModelProtocolIssue('ENVELOPE', 'invalid-usage');
  if (typeof prompt !== 'number' || typeof totalTokens !== 'number') return null;
  const promptTokens = prompt + (typeof toolPrompt === 'number' ? toolPrompt : 0);
  const completionTokens = (typeof candidates === 'number' ? candidates : 0) + (typeof thoughts === 'number' ? thoughts : 0);
  if (promptTokens + completionTokens !== totalTokens) throw new ModelProtocolIssue('ENVELOPE', 'invalid-usage');
  return { promptTokens, completionTokens, totalTokens, ...(typeof hit === 'number' ? { promptCacheHitTokens: hit } : {}) };
}

/** JSON and SSE chunks use the same candidate and part format. */
export function geminiFrame(value: unknown) {
  if (!record(value)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
  if (value.error !== undefined) {
    if (!record(value.error)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
    throw new ProviderError('HTTP', 'Gemini endpoint reported a generation error');
  }
  if (value.responseId !== undefined) geminiIdentity(value.responseId, 'invalid-response-id');
  if (value.modelVersion !== undefined) geminiIdentity(value.modelVersion, 'invalid-model');
  if (value.promptFeedback !== undefined && !record(value.promptFeedback)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
  const block = value.promptFeedback?.blockReason;
  if (block !== undefined) geminiIdentity(block, 'invalid-envelope');
  const promptBlocked = block !== undefined && block !== 'BLOCK_REASON_UNSPECIFIED';
  const candidates = value.candidates === undefined ? [] : value.candidates;
  if (!Array.isArray(candidates) || candidates.length > 1 || (promptBlocked && candidates.length)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-candidate');
  const candidate: unknown = candidates[0];
  if (candidate !== undefined && (!record(candidate) || (candidate.index !== undefined && candidate.index !== 0))) throw new ModelProtocolIssue('ENVELOPE', 'invalid-candidate');
  const content = candidate?.content;
  if (content !== undefined) {
    geminiShape(content, [], ['parts', 'role'], 'invalid-candidate');
    if ((content.role !== undefined && content.role !== 'model') || (content.parts !== undefined && !Array.isArray(content.parts))) throw new ModelProtocolIssue('ENVELOPE', 'invalid-candidate');
  }
  const parts: unknown[] = Array.isArray(content?.parts) ? content.parts : [];
  const finish = promptBlocked ? block : (candidate?.finishReason ?? undefined);
  if (finish !== undefined && finish !== '') geminiIdentity(finish, 'invalid-candidate');
  const reason = finish && finish !== 'FINISH_REASON_UNSPECIFIED' ? finish : undefined;
  return { id: value.responseId, model: value.modelVersion, parts: parts.map(geminiPart), reason, promptBlocked, usage: usage(value.usageMetadata), hasCandidate: candidate !== undefined };
}

function geminiPart(raw: unknown) {
  geminiShape(raw, [], ['text', 'thought', 'thoughtSignature', 'functionCall'], 'invalid-part');
  const { text, thought, thoughtSignature, functionCall } = raw;
  if (thought !== undefined && typeof thought !== 'boolean') throw new ModelProtocolIssue('ENVELOPE', 'invalid-part');
  if (thoughtSignature !== undefined && (typeof thoughtSignature !== 'string' || !thoughtSignature.trim())) throw new ModelProtocolIssue('ENVELOPE', 'invalid-part');
  if (text !== undefined && (typeof text !== 'string' || functionCall !== undefined)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-part');
  if (functionCall !== undefined) {
    geminiShape(functionCall, ['name'], ['id', 'args'], 'invalid-part');
    if (thought || typeof functionCall.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(functionCall.name) || (functionCall.args !== undefined && !record(functionCall.args))) throw new ModelProtocolIssue('ENVELOPE', 'invalid-part');
    if (functionCall.id !== undefined) geminiIdentity(functionCall.id, 'invalid-part');
  } else if (text === undefined && !thoughtSignature) throw new ModelProtocolIssue('ENVELOPE', 'invalid-part');
  return { text, thought, thoughtSignature, functionCall };
}

type GeminiFrame = ReturnType<typeof geminiFrame>;

export function finishGeminiReply(frame: GeminiFrame, binding: GeminiSource): GeminiGenerateContentReply {
  const { reason, promptBlocked, usage } = frame;
  if ((!frame.hasCandidate && !promptBlocked) || (promptBlocked && frame.parts.length)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-candidate');
  if (!reason) throw new ModelProtocolIssue('ENVELOPE', 'missing-terminal');
  const id = frame.id ?? 'gemini-reply-' + randomUUID();
  const model = frame.model ?? binding.model;
  const output: unknown[] = [];
  const parts = frame.parts.map(({ text, functionCall, thought, thoughtSignature }, position) => {
    const metadata = { ...(thoughtSignature === undefined ? {} : { thoughtSignature }), ...(thought === undefined ? {} : { thought }) };
    if (functionCall) {
      const index = output.length;
      output.push({ kind: 'tool-call', id: geminiCallId(id, position), name: functionCall.name, arguments: { encoding: 'json-value', value: functionCall.args ?? {} } });
      return { kind: 'output', index, ...(functionCall.id === undefined ? {} : { wireId: functionCall.id }), ...(functionCall.args === undefined ? { omittedArgs: true } : {}), ...metadata };
    }
    if (text === undefined) return { kind: 'signature', ...metadata };
    if (thought) return { kind: 'thought', text, ...(thoughtSignature === undefined ? {} : { thoughtSignature }) };
    const index = output.length;
    output.push({ kind: 'text', text });
    return { kind: 'output', index, ...metadata };
  });
  const signed = parts.some((part) => part.thoughtSignature !== undefined);
  if (signed) requireJson([parts, output]);
  const reply = requireGeminiGenerateContentReply({ formatVersion: 1, id, model, output, termination: { kind: geminiTerminationKind(reason, promptBlocked), reason }, usage, native: { format: 'gemini-generate-content', version: 1, bindingId: binding.bindingId, model: binding.model, ...(frame.id === undefined ? { idSource: 'local' } : {}), ...(frame.model === undefined ? { modelSource: 'configured' } : {}), parts, ...(promptBlocked ? { promptBlocked: true } : {}), ...(signed ? { partsSha256: geminiPartsProof(parts, output) } : {}) } });
  return freezeJson(reply);
}

export function acceptGeminiReply(value: unknown, binding: GeminiSource): GeminiGenerateContentReply {
  return finishGeminiReply(geminiFrame(value), binding);
}
