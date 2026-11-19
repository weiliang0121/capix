import { createHash } from 'node:crypto';
import { ProviderError } from './error.js';
import type { AnthropicMessagesBlock, AnthropicMessagesConfiguration, ModelExchange, ModelInputContent, ModelRequest, ModelRequestReservation } from './types.js';
import { record } from './value.js';

/** Reproduce nested tool schema and object-input field order after snapshot decoding. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** Include the fixed assistant layout: a later thinking block can follow text or a call within the same message. */
export function signedPrefix(requestPrefix: string, blocks: readonly AnthropicMessagesBlock[], output: ModelExchange['reply']['output']): string {
  return createHash('sha256')
    .update('capix.anthropic-messages.signed.v1\n')
    .update(requestPrefix)
    .update('\n')
    .update(JSON.stringify(canonical({ blocks, output })))
    .digest('hex');
}

export type MessagesBinding = Pick<AnthropicMessagesConfiguration, 'bindingId' | 'model' | 'anthropicVersion'>;

function contentBlock(item: ModelInputContent) {
  return item.kind === 'text' ? { type: 'text', text: item.text } : { type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.data } };
}

function encodeExchange({ reply, feedback }: ModelExchange, binding: MessagesBinding) {
  const native = reply.native;
  if (native.format !== 'anthropic-messages' || native.bindingId !== binding.bindingId || native.model !== binding.model || native.anthropicVersion !== binding.anthropicVersion) throw new TypeError('Messages history requires the original binding, model and API version');
  const content = native.blocks.map((block) => {
    if (block.kind === 'thinking') return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    if (block.kind === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data };
    const item = reply.output[block.index]!;
    if (item.kind === 'text') return contentBlock(item);
    if (item.arguments.encoding !== 'json-value') throw new TypeError('Messages tool use requires object input');
    return { type: 'tool_use', name: item.name, id: item.id, input: canonical(item.arguments.value) };
  });
  const byId = new Map(feedback.map((item) => [item.toolCallId, item]));
  const results = reply.output
    .filter((item) => item.kind === 'tool-call')
    .map((call) => {
      const result = byId.get(call.id)!;
      return { type: 'tool_result', tool_use_id: call.id, is_error: result.status === 'error', content: result.content.map(contentBlock) };
    });
  return [{ role: 'assistant', content }, ...(results.length ? [{ role: 'user', content: results }] : [])];
}

/** Project the exact system, tool catalog and messages used for prefix checks and sending. */
export function projectMessagesHistory(request: ModelRequest, binding: MessagesBinding) {
  const system = [];
  const messages: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (messages.length) throw new TypeError('Messages only supports a leading system prefix');
      system.push(...(typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.map(contentBlock)));
    } else {
      if (!messages.length && message.role !== 'user') throw new TypeError('Messages requires an initial user turn');
      messages.push({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(contentBlock) });
    }
  }
  if (!messages.length) throw new TypeError('Messages requires a user turn');
  const tools = request.tools?.map((tool) => {
    if (tool.parameters.type !== 'object') throw new TypeError('Messages tool schemas require object input');
    return { name: tool.name, description: tool.description, input_schema: canonical(tool.parameters) };
  });
  // Newlines frame UTF-8 JSON records unambiguously. Copy the incremental
  // state at each signed boundary without rehashing earlier messages.
  const prefix = createHash('sha256').update('capix.anthropic-messages.prefix.v1\n');
  const append = (value: unknown) => prefix.update(JSON.stringify(value)).update('\n');
  append({ system, tools: tools ?? [] });
  for (const message of messages) append(message);
  for (const exchange of request.exchanges ?? []) {
    const native = exchange.reply.native;
    if (native.format === 'anthropic-messages' && native.prefixSha256 !== undefined && native.prefixSha256 !== signedPrefix(prefix.copy().digest('hex'), native.blocks, exchange.reply.output)) throw new TypeError('Signed Messages history requires its original conversation prefix');
    for (const message of encodeExchange(exchange, binding)) {
      messages.push(message);
      append(message);
    }
  }
  return { system, tools, messages, prefixSha256: prefix.digest('hex') };
}

/** Validate fixed history and any proposed growth against the saved signed prefix. */
export function assertMessagesContinuation(request: ModelRequest, reservation?: ModelRequestReservation): void {
  const binding = request.exchanges?.[0]?.reply.native;
  if (binding?.format !== 'anthropic-messages') throw new ProviderError('REQUEST', 'Expected native Messages history');
  try {
    projectMessagesHistory(request, binding);
  } catch {
    throw new ProviderError('REQUEST', 'Messages history requires its original binding and a valid conversation prefix');
  }
  if (reservation !== undefined) assertMessagesReservation(request, reservation);
}

/** A possible change after the last signed assistant reply does not alter its prefix. */
export function assertMessagesReservation(request: ModelRequest, reservation: ModelRequestReservation): void {
  const history = request.exchanges ?? [];
  const signedIndex = history.findLastIndex(({ reply }) => reply.native.format === 'anthropic-messages' && reply.native.prefixSha256 !== undefined);
  if (signedIndex < 0) return;
  if (reservation.mutableContext || reservation.contextGrowthBytes > 0) throw new ProviderError('REQUEST', 'Dynamic context can change a signed Messages prefix');
  if (reservation.imageOmissionBytes) {
    const prior = history.slice(0, signedIndex);
    const affected = prior.some(({ feedback }, index) => (reservation.imageOmissionByExchange?.[index] ?? 1) > 0 && feedback.some((result) => result.content.some((part) => part.kind === 'image')));
    if (affected) throw new ProviderError('REQUEST', 'Image retention can change a signed Messages prefix');
  }
}
