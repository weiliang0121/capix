import { decodeBase64 } from '@weiliang0121/capix-platform/bytes';
import { nativeReplyProtocol } from './native-reply.js';
import type { ChatCompletionsReply, AnthropicMessagesReply, GeminiGenerateContentReply, OpenAIResponsesReply, ModelUsage, ModelOutput, ModelExchange, ModelReply, ModelRequest, ModelToolCall, ToolFeedback, ToolResult } from './types.js';
import { count, identity, maximumModelExchangeBytes, maximumModelRequestBytes, record, requireJson, shape, toolLimit } from './value.js';

export { terminationKind } from './chat-contract.js';
export { messagesTerminationKind } from './messages-contract.js';
export function isChatCompletionsReply(reply: ModelReply): reply is ChatCompletionsReply {
  return reply.native.format === 'chat-completions';
}

export function requireChatCompletionsReply(value: unknown): ChatCompletionsReply {
  const reply = requireModelReply(value);
  if (!isChatCompletionsReply(reply)) throw new TypeError('Expected Chat Completions reply');
  return reply;
}
export function requireAnthropicMessagesReply(value: unknown): AnthropicMessagesReply {
  const reply = requireModelReply(value);
  if (reply.native.format !== 'anthropic-messages') throw new TypeError('Expected Anthropic Messages reply');
  return reply as AnthropicMessagesReply;
}
export function requireOpenAIResponsesReply(value: unknown): OpenAIResponsesReply {
  const reply = requireModelReply(value);
  if (reply.native.format !== 'openai-responses') throw new TypeError('Expected OpenAI Responses reply');
  return reply as OpenAIResponsesReply;
}

export function requireGeminiGenerateContentReply(value: unknown): GeminiGenerateContentReply {
  const reply = requireModelReply(value);
  if (reply.native.format !== 'gemini-generate-content') throw new TypeError('Expected Gemini GenerateContent reply');
  return reply as GeminiGenerateContentReply;
}

/** Complete validation of the single persistent reply material; returns the same object. */
export function requireModelReply(value: unknown): ModelReply {
  requireJson(value);
  checkReply(value);
  return value;
}
function checkReply(value: unknown): asserts value is ModelReply {
  shape(value, ['formatVersion', 'id', 'model', 'output', 'termination', 'usage', 'native']);
  if (value.formatVersion !== 1) throw new TypeError('Unsupported model reply version');
  identity(value.id);
  identity(value.model);
  shape(value.termination, ['kind', 'reason']);
  identity(value.termination.reason);
  if (!record(value.native)) throw new TypeError('Unsupported model native material');
  const protocol = nativeReplyProtocol(value.native);
  const kind = value.termination.kind;
  if (kind !== 'completed' && kind !== 'refused' && kind !== 'incomplete') throw new TypeError('Invalid model termination');
  if (!Array.isArray(value.output)) throw new TypeError('Model output is invalid');
  const calls = new Set<string>();
  for (const item of value.output) {
    if (record(item) && item.kind === 'text') checkText(item);
    else {
      shape(item, ['kind', 'id', 'name', 'arguments']);
      if (item.kind !== 'tool-call') throw new TypeError('Unsupported model output kind');
      identity(item.id);
      toolName(item.name);
      if (protocol.argumentEncoding === 'json-text') {
        shape(item.arguments, ['encoding', 'text']);
        if (item.arguments.encoding !== 'json-text' || typeof item.arguments.text !== 'string') throw new TypeError('Invalid JSON text tool arguments');
      } else {
        shape(item.arguments, ['encoding', 'value']);
        if (item.arguments.encoding !== 'json-value' || !record(item.arguments.value)) throw new TypeError('Invalid JSON object tool arguments');
      }
      if (calls.has(item.id) || calls.size >= toolLimit) throw new TypeError('Duplicate or excessive model tool calls');
      calls.add(item.id);
    }
  }
  if (value.usage !== null) {
    shape(value.usage, ['promptTokens', 'completionTokens', 'totalTokens'], ['promptCacheHitTokens', 'promptCacheMissTokens', 'promptCacheWriteTokens']);
    const { promptTokens, completionTokens, totalTokens, promptCacheHitTokens: hit, promptCacheMissTokens: miss, promptCacheWriteTokens: write } = value.usage;
    if (!count(promptTokens) || !count(completionTokens) || !count(totalTokens) || (hit !== undefined && (!count(hit) || hit > promptTokens)) || (miss !== undefined && (!count(miss) || miss > promptTokens)) || (write !== undefined && (!count(write) || write > promptTokens)) || (typeof hit === 'number' && typeof miss === 'number' && hit !== promptTokens - miss)) throw new TypeError('Invalid model usage counts');
  }
  protocol.check(value.native, { id: value.id, model: value.model, output: value.output as ModelOutput[], termination: { kind, reason: value.termination.reason }, usage: value.usage as ModelUsage | null }, calls.size);
}
function checkText(value: unknown): void {
  shape(value, ['kind', 'text']);
  if (value.kind !== 'text' || typeof value.text !== 'string') throw new TypeError('Invalid model text block');
}
/** Validate encoding and declared format without decoding pixels or executing image metadata. */
function checkInputContent(value: unknown): void {
  if (record(value) && value.kind === 'text') {
    checkText(value);
    return;
  }
  shape(value, ['kind', 'mimeType', 'data']);
  if (value.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mimeType as string) || typeof value.data !== 'string' || !value.data.length || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.data)) throw new TypeError('Invalid model image encoding');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(value.data);
  } catch {
    throw new TypeError('Invalid model image encoding');
  }
  const fields = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCC = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const png = bytes.length >= 45 && fields.getUint32(0) === 0x89504e47 && fields.getUint32(4) === 0x0d0a1a0a && fields.getUint32(8) === 13 && fourCC(12) === 'IHDR' && fields.getUint32(16) > 0 && fields.getUint32(20) > 0 && fields.getUint32(bytes.length - 12) === 0 && fourCC(bytes.length - 8) === 'IEND' && fields.getUint32(bytes.length - 4) === 0xae426082;
  const jpeg = bytes.length >= 6 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  const webp = bytes.length >= 20 && fourCC(0) === 'RIFF' && fields.getUint32(4, true) === bytes.length - 8 && fourCC(8) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(fourCC(12)) && fields.getUint32(16, true) > 0 && fields.getUint32(16, true) <= bytes.length - 20;
  if (!(value.mimeType === 'image/png' ? png : value.mimeType === 'image/jpeg' ? jpeg : webp)) throw new TypeError('Model image does not match its declared format');
}
function toolName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('Invalid tool name');
}
function checkResult(value: unknown, feedback: boolean): asserts value is ToolResult {
  shape(value, feedback ? ['toolCallId', 'status', 'content'] : ['status', 'content']);
  if (feedback) identity(value.toolCallId);
  if (typeof value.status !== 'string' || !['ok', 'error'].includes(value.status) || !Array.isArray(value.content) || !value.content.length || value.content.length > 32) throw new TypeError('Invalid tool feedback content');
  for (const item of value.content) checkInputContent(item);
}
export function requireToolResult(value: unknown): ToolResult {
  requireJson(value);
  checkResult(value, false);
  return value;
}
export function requireToolFeedback(value: unknown): ToolFeedback {
  requireJson(value);
  checkResult(value, true);
  return value as ToolFeedback;
}
function checkExchange(value: unknown): asserts value is ModelExchange {
  shape(value, ['reply', 'feedback']);
  checkReply(value.reply);
  if (value.reply.termination.kind !== 'completed') throw new TypeError('Incomplete or refused reply cannot be continued as a closed exchange');
  if (!Array.isArray(value.feedback)) throw new TypeError('Tool feedback must be an array');
  const calls = value.reply.output.filter((item) => item.kind === 'tool-call');
  if (value.feedback.length !== calls.length) throw new TypeError('Tool feedback does not close the model exchange');
  const ids = new Set<string>();
  for (const feedback of value.feedback) {
    checkResult(feedback, true);
    const id = (feedback as ToolFeedback).toolCallId;
    if (ids.has(id) || !calls.some((call) => call.id === id)) throw new TypeError('Tool feedback has a duplicate or foreign call identity');
    ids.add(id);
  }
}
export function requireModelExchange(value: unknown): ModelExchange {
  requireJson(value, maximumModelExchangeBytes);
  checkExchange(value);
  return value;
}
export function requireModelRequest(value: unknown): ModelRequest {
  measureModelRequest(value);
  return value as ModelRequest;
}

/** Validate the request with structural room for future feedback and message nodes. */
export function assertModelRequestNodeCapacity(request: ModelRequest, additionalNodes: number): void {
  if (!count(additionalNodes)) throw new RangeError('Invalid model request node reservation');
  measureModelRequest(request, additionalNodes);
}

/** Internal preparation boundary shared by request validation and provider inspection. */
export function measureModelRequest(value: unknown, additionalNodes = 0): number {
  const bytes = requireJson(value, maximumModelRequestBytes, additionalNodes);
  checkRequest(value);
  return bytes;
}

function checkRequest(value: unknown): asserts value is ModelRequest {
  shape(value, ['messages'], ['exchanges', 'tools', 'toolChoice', 'maxTokens', 'responseFormat', 'temperature', 'stream']);
  if (!Array.isArray(value.messages) || !value.messages.length) throw new TypeError('At least one model message is required');
  for (const message of value.messages) {
    shape(message, ['role', 'content']);
    if (typeof message.role !== 'string' || !['system', 'user', 'assistant'].includes(message.role)) throw new TypeError('Model message has an unsupported role or content');
    if (typeof message.content !== 'string') {
      if (!Array.isArray(message.content) || !message.content.length || message.content.length > 32) throw new TypeError('Invalid model message content');
      for (const item of message.content) {
        if (message.role !== 'user') checkText(item);
        else checkInputContent(item);
      }
    }
  }
  if (value.exchanges !== undefined) {
    if (!Array.isArray(value.exchanges)) throw new TypeError('Model exchanges must be an array');
    for (const exchange of value.exchanges) requireModelExchange(exchange);
  }
  const names = new Set<string>();
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || !value.tools.length || value.tools.length > toolLimit) throw new TypeError('Model tool catalog must contain 1 to 32 tools');
    for (const tool of value.tools) {
      shape(tool, ['name', 'description', 'parameters']);
      toolName(tool.name);
      if (names.has(tool.name) || typeof tool.description !== 'string' || !record(tool.parameters)) throw new TypeError('Invalid or duplicate model tool declaration');
      names.add(tool.name);
    }
  }
  if (value.toolChoice !== undefined) {
    if (record(value.toolChoice)) {
      shape(value.toolChoice, ['name']);
      toolName(value.toolChoice.name);
      if (!names.has(value.toolChoice.name)) throw new TypeError('Selected model tool is not declared');
    } else if (typeof value.toolChoice !== 'string' || !['auto', 'none', 'required'].includes(value.toolChoice)) throw new TypeError('Unsupported model tool choice');
    if (value.toolChoice !== 'none' && !names.size) throw new TypeError('Model tool choice requires tools');
  }
  if (value.maxTokens !== undefined && (!count(value.maxTokens) || value.maxTokens < 1)) throw new TypeError('maxTokens must be a positive integer');
  if (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) throw new TypeError('temperature must be between zero and two');
  if (value.responseFormat !== undefined && (typeof value.responseFormat !== 'string' || !['text', 'json_object'].includes(value.responseFormat))) throw new TypeError('Unsupported response format');
  if (value.stream !== undefined && typeof value.stream !== 'boolean') throw new TypeError('stream must be a boolean');
}

/**
 * Decode one admitted tool call for a consumer. The member schema validates the result;
 * the stored call keeps its original representation for protocol continuation.
 */
export function readModelToolArguments(call: ModelToolCall): unknown {
  if (call.arguments.encoding === 'json-value') return call.arguments.value;
  try {
    return JSON.parse(call.arguments.text);
  } catch {
    throw new SyntaxError('Model tool arguments contain invalid JSON');
  }
}

/** Text projection only. Completion, refusal and empty-output policies belong to callers. */
export function modelReplyText(reply: ModelReply): string {
  let text = '';
  for (const item of reply.output) {
    if (item.kind === 'tool-call') throw new TypeError('Tool-call output cannot be projected as a text reply');
    text += item.text;
  }
  return text;
}
