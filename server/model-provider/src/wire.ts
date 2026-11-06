import { requireModelReply, terminationKind } from './contract.js';
import { ProviderError } from './error.js';
import type { ModelExchange, ModelOutput, ModelReply, ModelRequest } from './types.js';
import { acceptUsage } from './usage.js';
import { freezeJson, record, toolLimit } from './value.js';

/** Shared JSON/SSE normalization. Native fields never contain duplicated public output. */
export function acceptWireReply(value: unknown): ModelReply {
  if (!record(value) || !Array.isArray(value.choices) || value.choices.length !== 1 || value.error != null) throw envelope();
  const choice: unknown = value.choices[0];
  if (!record(choice) || (choice.index !== undefined && choice.index !== 0) || !record(choice.message) || typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw envelope();
  const message = choice.message;
  if ((message.role !== undefined && message.role !== 'assistant') || message.function_call != null || message.refusal != null || (message.content !== null && typeof message.content !== 'string') || (message.reasoning_content != null && typeof message.reasoning_content !== 'string')) throw envelope();
  const output: ModelOutput[] = typeof message.content === 'string' ? [{ kind: 'text', text: message.content }] : [];
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > toolLimit) throw envelope();
    for (const call of message.tool_calls) {
      if (!record(call) || typeof call.id !== 'string' || call.type !== 'function' || !record(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') throw envelope();
      output.push({ kind: 'tool-call', id: call.id, name: call.function.name, arguments: { encoding: 'json-text', text: call.function.arguments } });
    }
  }
  // Streaming transports commonly start with an empty content placeholder,
  // whereas the equivalent JSON tool reply uses null. Neither carries text.
  if (message.content === '' && output.some((item) => item.kind === 'tool-call')) output.shift();
  if (message.content === null && !output.length && choice.finish_reason === 'stop') throw envelope();
  const reply = { formatVersion: 1, id: value.id, model: value.model, output, termination: { kind: terminationKind(choice.finish_reason), reason: choice.finish_reason }, usage: acceptUsage(value.usage), native: { format: 'chat-completions', version: 1, ...(typeof message.reasoning_content === 'string' ? { reasoningContent: message.reasoning_content } : {}) } };
  try {
    return freezeJson(requireModelReply(reply));
  } catch {
    throw envelope();
  }
}

export function encodeMessages(request: ModelRequest): unknown[] {
  return [...request.messages.map((message) => ({ role: message.role, content: message.content })), ...(request.exchanges ?? []).flatMap(encodeExchange)];
}
function encodeExchange({ reply, feedback }: ModelExchange): unknown[] {
  const calls = reply.output.filter((item) => item.kind === 'tool-call');
  const byId = new Map(feedback.map((item) => [item.toolCallId, item]));
  return [
    { role: 'assistant', content: reply.output.find((item) => item.kind === 'text')?.text ?? null, ...(reply.native.reasoningContent === undefined ? {} : { reasoning_content: reply.native.reasoningContent }), ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments.text } })) } : {}) },
    ...calls.map((call) => {
      const result = byId.get(call.id)!;
      // Both success and failure are explicit data. No tool body becomes a system instruction.
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: result.status, content: result.content }) };
    }),
  ];
}
function envelope(): ProviderError {
  return new ProviderError('ENVELOPE', 'Model response is not a supported Chat Completions reply');
}
