import type { ModelExchange, ModelReply, ModelRequest, ToolFeedback, ToolResult } from './types.js';
import { count, identity, record, requireJson, shape, toolLimit } from './value.js';

export function terminationKind(reason: string): ModelReply['termination']['kind'] {
  return reason === 'stop' || reason === 'tool_calls' ? 'completed' : reason === 'content_filter' ? 'refused' : 'incomplete';
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
  if (value.termination.kind !== terminationKind(value.termination.reason)) throw new TypeError('Model termination does not match its reason');
  shape(value.native, ['format', 'version'], ['reasoningContent']);
  if (value.native.format !== 'chat-completions' || value.native.version !== 1 || ('reasoningContent' in value.native && typeof value.native.reasoningContent !== 'string')) throw new TypeError('Unsupported model native material');
  if (!Array.isArray(value.output) || value.output.length > toolLimit + 1) throw new TypeError('Model output is invalid');
  let text = false;
  const calls = new Set<string>();
  for (const item of value.output) {
    if (record(item) && item.kind === 'text') {
      checkText(item);
      if (text || calls.size) throw new TypeError('Unsupported Chat Completions output order');
      text = true;
    } else {
      shape(item, ['kind', 'id', 'name', 'arguments']);
      if (item.kind !== 'tool-call') throw new TypeError('Unsupported model output kind');
      identity(item.id);
      toolName(item.name);
      shape(item.arguments, ['encoding', 'text']);
      if (item.arguments.encoding !== 'json-text' || typeof item.arguments.text !== 'string') throw new TypeError('Unsupported tool argument representation');
      if (calls.has(item.id) || calls.size >= toolLimit) throw new TypeError('Duplicate or excessive model tool calls');
      calls.add(item.id);
    }
  }
  if ((value.termination.reason === 'tool_calls' && !calls.size) || (value.termination.reason === 'stop' && calls.size)) throw new TypeError('Model termination disagrees with tool output');
  if (value.usage !== null) {
    shape(value.usage, ['promptTokens', 'completionTokens', 'totalTokens'], ['promptCacheHitTokens', 'promptCacheMissTokens']);
    const { promptTokens, completionTokens, totalTokens, promptCacheHitTokens: hit, promptCacheMissTokens: miss } = value.usage;
    if (!count(promptTokens) || !count(completionTokens) || !count(totalTokens) || (hit !== undefined && (!count(hit) || hit > promptTokens)) || (miss !== undefined && (!count(miss) || miss > promptTokens)) || (typeof hit === 'number' && typeof miss === 'number' && hit !== promptTokens - miss)) throw new TypeError('Invalid model usage counts');
  }
}
function checkText(value: unknown): void {
  shape(value, ['kind', 'text']);
  if (value.kind !== 'text' || typeof value.text !== 'string') throw new TypeError('Tool content must contain text blocks');
}
function toolName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('Invalid tool name');
}
function checkResult(value: unknown, feedback: boolean): asserts value is ToolResult {
  shape(value, feedback ? ['toolCallId', 'status', 'content'] : ['status', 'content']);
  if (feedback) identity(value.toolCallId);
  if (typeof value.status !== 'string' || !['ok', 'error'].includes(value.status) || !Array.isArray(value.content) || !value.content.length || value.content.length > 32) throw new TypeError('Invalid tool feedback content');
  for (const item of value.content) checkText(item);
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
  requireJson(value);
  checkExchange(value);
  return value;
}
export function requireModelRequest(value: unknown): ModelRequest {
  measureModelRequest(value);
  return value as ModelRequest;
}

/** Internal preparation boundary shared by request validation and provider inspection. */
export function measureModelRequest(value: unknown): number {
  const bytes = requireJson(value);
  checkRequest(value);
  return bytes;
}

function checkRequest(value: unknown): asserts value is ModelRequest {
  shape(value, ['messages'], ['exchanges', 'tools', 'toolChoice', 'maxTokens', 'responseFormat', 'temperature', 'stream']);
  if (!Array.isArray(value.messages) || !value.messages.length) throw new TypeError('At least one model message is required');
  for (const message of value.messages) {
    shape(message, ['role', 'content']);
    if (typeof message.role !== 'string' || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new TypeError('Model message has an unsupported role or content');
  }
  if (value.exchanges !== undefined) {
    if (!Array.isArray(value.exchanges)) throw new TypeError('Model exchanges must be an array');
    for (const exchange of value.exchanges) checkExchange(exchange);
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

/** Text projection only. Completion, refusal and empty-output policies belong to callers. */
export function modelReplyText(reply: ModelReply): string {
  let text = '';
  for (const item of reply.output) {
    if (item.kind === 'tool-call') throw new TypeError('Tool-call output cannot be projected as a text reply');
    text += item.text;
  }
  return text;
}
