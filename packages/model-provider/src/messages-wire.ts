import { messagesUsageKeys, projectMessagesUsage, validMessagesCounts } from './messages-contract.js';
import { projectMessagesHistory, signedPrefix, type MessagesBinding } from './messages-history.js';
import { messagesTerminationKind, requireAnthropicMessagesReply } from './contract.js';
import { ModelProtocolIssue } from './error.js';
import type { AnthropicMessagesBlock, AnthropicMessagesConfiguration, AnthropicMessagesReply, AnthropicMessagesUsageCounts, ModelRequest } from './types.js';
import { freezeJson, identity, record, shape } from './value.js';

export function encodeMessagesRequest(request: ModelRequest, configuration: MessagesBinding & Pick<AnthropicMessagesConfiguration, 'maxTokens' | 'thinkingBudgetTokens'>) {
  if (request.responseFormat === 'json_object') throw new ModelProtocolIssue('REQUEST', 'unsupported-response-format');
  if (request.temperature !== undefined && request.temperature > 1) throw new TypeError('Unsupported Messages option');
  const maxTokens = request.maxTokens ?? configuration.maxTokens;
  const budget = configuration.thinkingBudgetTokens;
  if (budget !== undefined && (maxTokens <= budget || (request.temperature !== undefined && request.temperature !== 1) || (request.toolChoice !== undefined && request.toolChoice !== 'auto' && request.toolChoice !== 'none'))) throw new TypeError('Messages thinking requires a larger output budget and compatible sampling and tool choice');
  const choice = request.toolChoice;
  const { system, tools, messages, prefixSha256 } = projectMessagesHistory(request, configuration);
  const last = messages.at(-1);
  if (budget !== undefined && record(last) && last.role === 'assistant') throw new TypeError('Messages thinking cannot prefill an assistant turn');
  if (budget !== undefined && request.exchanges?.at(-1)?.feedback.length) {
    // Every exchange following the last genuine user input belongs to the same
    // assistant turn; a second tool call need not start a second thinking block.
    const native = request.exchanges[0]!.reply.native;
    const first = native.format === 'anthropic-messages' ? native.blocks[0] : undefined;
    if (request.messages.at(-1)?.role !== 'user' || (first?.kind !== 'thinking' && first?.kind !== 'redacted_thinking')) throw new TypeError('Manual thinking requires a leading thinking block when continuing tool use');
  }
  const body = JSON.stringify({ model: configuration.model, max_tokens: maxTokens, ...(budget === undefined ? {} : { thinking: { type: 'enabled', budget_tokens: budget } }), ...(system.length ? { system } : {}), messages, stream: request.stream === true, ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(tools ? { tools } : {}), ...(choice === undefined || (!tools && choice === 'none') ? {} : { tool_choice: typeof choice === 'string' ? { type: choice === 'required' ? 'any' : choice } : { type: 'tool', name: choice.name } }) });
  return { body, prefixSha256 };
}

/** Messages uses the same bounded identities in a finished response and message_start. */
export function messagesIdentity(value: unknown, field: 'id' | 'model'): string {
  if (value === undefined) throw new ModelProtocolIssue('ENVELOPE', field === 'id' ? 'missing-response-id' : 'missing-model');
  try {
    identity(value);
    return value;
  } catch {
    throw new ModelProtocolIssue('ENVELOPE', field === 'id' ? 'invalid-response-id' : 'invalid-model');
  }
}

/** Select the final counters understood by this version. Null fields carry no observation. */
export function readMessagesUsage(value: unknown): AnthropicMessagesUsageCounts {
  if (value == null) return {};
  if (!record(value)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-usage');
  const counts: Record<string, unknown> = {};
  for (const key of messagesUsageKeys) {
    if (value[key] != null) counts[key] = value[key];
  }
  if (!validMessagesCounts(counts)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-usage');
  return counts;
}

/** Read the fields shared by JSON content and an SSE block start. A thinking signature can arrive in a delta. */
export function readMessagesBlock(block: unknown) {
  if (!record(block)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-block');
  try {
    switch (block.type) {
      case 'text':
        shape(block, ['type', 'text'], ['citations']);
        if (typeof block.text !== 'string') break;
        if (block.citations != null && !(Array.isArray(block.citations) && !block.citations.length)) throw new ModelProtocolIssue('ENVELOPE', 'unsupported-block');
        return { type: 'text' as const, text: block.text };
      case 'thinking':
        shape(block, ['type', 'thinking'], ['signature']);
        if (typeof block.thinking !== 'string' || (block.signature !== undefined && typeof block.signature !== 'string')) break;
        return { type: 'thinking' as const, thinking: block.thinking, signature: block.signature };
      case 'redacted_thinking':
        shape(block, ['type', 'data']);
        if (typeof block.data !== 'string' || !block.data) break;
        return { type: 'redacted_thinking' as const, data: block.data };
      case 'tool_use':
        shape(block, ['type', 'id', 'name', 'input'], ['caller', 'toolset_name']);
        if (block.toolset_name != null || (record(block.caller) && block.caller.type !== 'direct')) throw new ModelProtocolIssue('ENVELOPE', 'unsupported-block');
        if (block.caller !== undefined) shape(block.caller, ['type']);
        identity(block.id);
        if (typeof block.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(block.name) || !record(block.input)) break;
        return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
      default:
        throw new ModelProtocolIssue('ENVELOPE', typeof block.type === 'string' ? 'unsupported-block' : 'invalid-block');
    }
  } catch (error) {
    if (error instanceof ModelProtocolIssue) throw error;
  }
  throw new ModelProtocolIssue('ENVELOPE', 'invalid-block');
}

/** Both transport paths pass a finished sequence of native blocks through the same checks. */
export function acceptMessagesReply(value: unknown, binding: MessagesBinding & { prefixSha256: string }): AnthropicMessagesReply {
  if (!record(value) || value.type !== 'message' || value.role !== 'assistant' || value.error != null || !Array.isArray(value.content) || typeof value.stop_reason !== 'string') throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
  const id = messagesIdentity(value.id, 'id');
  const model = messagesIdentity(value.model, 'model');
  const output = [];
  const blocks: AnthropicMessagesBlock[] = [];
  for (const raw of value.content) {
    const block = readMessagesBlock(raw);
    switch (block.type) {
      case 'text':
        blocks.push({ kind: 'output', index: output.length });
        output.push({ kind: 'text', text: block.text });
        break;
      case 'tool_use':
        blocks.push({ kind: 'output', index: output.length });
        output.push({ kind: 'tool-call', id: block.id, name: block.name, arguments: { encoding: 'json-value', value: block.input } });
        break;
      case 'thinking':
        if (!block.signature?.trim()) throw new ModelProtocolIssue('ENVELOPE', 'missing-thinking-signature');
        blocks.push({ kind: 'thinking', thinking: block.thinking, signature: block.signature });
        break;
      case 'redacted_thinking':
        if (!block.data.trim()) throw new ModelProtocolIssue('ENVELOPE', 'invalid-block');
        blocks.push({ kind: 'redacted_thinking', data: block.data });
        break;
    }
  }
  const counts = readMessagesUsage(value.usage);
  const projected = projectMessagesUsage(counts);
  const usage = projected?.totalTokens === undefined ? null : projected;
  const partial = usage === null && Object.keys(counts).length ? { partialUsage: counts } : {};
  const reply = requireAnthropicMessagesReply({ formatVersion: 1, id, model, output, termination: { kind: messagesTerminationKind(value.stop_reason), reason: value.stop_reason }, usage, native: { ...partial, format: 'anthropic-messages', version: 1, bindingId: binding.bindingId, model: binding.model, anthropicVersion: binding.anthropicVersion, ...(blocks.some((block) => block.kind !== 'output') ? { prefixSha256: binding.prefixSha256 } : {}), blocks } });
  // The envelope check bounds nested object input before hashing and freezes
  // no caller-owned data: both JSON and stream decoders own these values.
  if (reply.native.prefixSha256 === undefined) return freezeJson(reply);
  return freezeJson({ ...reply, native: { ...reply.native, prefixSha256: signedPrefix(binding.prefixSha256, reply.native.blocks, reply.output) } });
}
