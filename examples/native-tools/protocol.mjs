import { z } from 'zod';
import { fixed } from './value.mjs';

const identity = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const maximumToolCalls = 32;
const toolCall = z.strictObject({ kind: z.literal('tool-call'), id: identity, name: identity, arguments: z.strictObject({ encoding: z.literal('json-text'), text: z.string() }).readonly() }).readonly();
const text = z.strictObject({ kind: z.literal('text'), text: z.string() }).readonly();
const finishReason = z.enum(['stop', 'tool_calls', 'length', 'content_filter']);
const termination = z.strictObject({ kind: z.enum(['completed', 'incomplete', 'refused']), reason: finishReason }).readonly();
const usage = z.strictObject({ promptTokens: count, completionTokens: count, totalTokens: count, promptCacheHitTokens: count.optional(), promptCacheMissTokens: count.optional() }).readonly();
export const replySchema = z
  .strictObject({
    formatVersion: z.literal(1),
    id: identity,
    model: identity,
    output: z
      .array(z.discriminatedUnion('kind', [text, toolCall]))
      .max(maximumToolCalls + 1)
      .readonly(),
    termination,
    usage: usage.nullable(),
    native: z.strictObject({ format: z.literal('deepseek.chat-completions'), version: z.literal(1), source: z.literal('deepseek'), reasoningContent: z.string().optional() }).readonly(),
  })
  .readonly();

const wireCall = z.strictObject({ id: identity, type: z.literal('function'), function: z.strictObject({ name: identity, arguments: z.string() }) });
const wireUsage = z.strictObject({ prompt_tokens: count, completion_tokens: count, total_tokens: count, prompt_cache_hit_tokens: count.optional(), prompt_cache_miss_tokens: count.optional() });
const wireReply = z.strictObject({ id: identity, object: z.literal('chat.completion').optional(), created: count.optional(), model: identity, choices: z.tuple([z.strictObject({ index: z.literal(0), message: z.strictObject({ role: z.literal('assistant'), content: z.string().nullable(), reasoning_content: z.string().optional(), tool_calls: z.array(wireCall).min(1).max(maximumToolCalls).optional() }), finish_reason: finishReason })]), usage: wireUsage.nullable().optional() });

/** @typedef {import('zod').infer<typeof replySchema>} ModelReply */

/**
 * Candidate shared reply; this is an offline codec, not an installed Provider.
 * @param {unknown} raw
 * @returns {ModelReply}
 */
export function acceptReply(raw) {
  const value = wireReply.parse(fixed(raw));
  const message = value.choices[0].message;
  const reported = value.usage;
  const output = [...(message.content === null ? [] : [{ kind: 'text', text: message.content }]), ...(message.tool_calls ?? []).map((call) => ({ kind: 'tool-call', id: call.id, name: call.function.name, arguments: { encoding: 'json-text', text: call.function.arguments } }))];
  return validateReply({
    formatVersion: 1,
    id: value.id,
    model: value.model,
    output,
    termination: { kind: kindOf(value.choices[0].finish_reason), reason: value.choices[0].finish_reason },
    usage: reported ? { promptTokens: reported.prompt_tokens, completionTokens: reported.completion_tokens, totalTokens: reported.total_tokens, ...(reported.prompt_cache_hit_tokens === undefined ? {} : { promptCacheHitTokens: reported.prompt_cache_hit_tokens }), ...(reported.prompt_cache_miss_tokens === undefined ? {} : { promptCacheMissTokens: reported.prompt_cache_miss_tokens }) } : null,
    native: { format: 'deepseek.chat-completions', version: 1, source: 'deepseek', ...(message.reasoning_content === undefined ? {} : { reasoningContent: message.reasoning_content }) },
  });
}

/**
 * Restored data is checked just like newly received data. No network adapter is needed.
 * @param {unknown} value
 * @returns {ModelReply}
 */
export function validateReply(value) {
  const reply = replySchema.parse(fixed(value));
  if (reply.termination.kind !== kindOf(reply.termination.reason)) throw new TypeError('Reply termination does not match its reason');
  if (reply.usage) {
    const usage = reply.usage;
    const hit = usage.promptCacheHitTokens;
    const miss = usage.promptCacheMissTokens;
    if ((hit !== undefined && hit > usage.promptTokens) || (miss !== undefined && miss > usage.promptTokens) || (hit !== undefined && miss !== undefined && hit !== usage.promptTokens - miss)) throw new TypeError('Reply prompt cache usage is inconsistent');
  }
  const calls = reply.output.filter((item) => item.kind === 'tool-call');
  if (calls.length > maximumToolCalls) throw new TypeError('Reply exceeds tool call limit');
  if (new Set(calls.map((item) => item.id)).size !== calls.length) throw new TypeError('Duplicate tool call identity');
  if (reply.termination.reason === 'tool_calls' && calls.length === 0) throw new TypeError('Tool termination has no calls');
  if (reply.termination.reason === 'stop' && calls.length !== 0) throw new TypeError('Text termination unexpectedly includes tools');
  const firstCall = reply.output.findIndex((item) => item.kind === 'tool-call');
  if (reply.output.filter((item) => item.kind === 'text').length > 1 || (firstCall !== -1 && reply.output.slice(firstCall).some((item) => item.kind === 'text'))) throw new TypeError('Unsupported Chat Completions output layout');
  return fixed(reply);
}

function kindOf(reason) {
  return reason === 'length' ? 'incomplete' : reason === 'content_filter' ? 'refused' : 'completed';
}

export const resultSchema = z.strictObject({ status: z.enum(['ok', 'error']), content: z.array(text).min(1).max(32).readonly() });
const feedbackSchema = resultSchema.extend({ toolCallId: identity });
/** @typedef {import('zod').infer<typeof resultSchema>} ToolResult */
/** @typedef {import('zod').infer<typeof feedbackSchema>} ToolFeedback */

/**
 * The loop owns the call identity; an author returns only status and content.
 * @param {string} toolCallId
 * @param {ToolResult} result
 * @returns {ToolFeedback}
 */
export function acceptFeedback(toolCallId, result) {
  identity.parse(toolCallId);
  return fixed({ toolCallId, ...resultSchema.parse(fixed(result)) });
}

/**
 * Reconstruct history from shared facts. Native fields cannot override shared fields.
 * @param {ModelReply} value
 * @param {readonly ToolFeedback[]} feedback
 */
export function encodeHistory(value, feedback) {
  const reply = validateReply(value);
  if (reply.termination.kind !== 'completed') throw new TypeError('Incomplete/refused reply cannot continue this tool fixture');
  const calls = reply.output.filter((item) => item.kind === 'tool-call');
  const results = z.array(feedbackSchema).parse(fixed(feedback));
  if (results.length !== calls.length || new Set(results.map((item) => item.toolCallId)).size !== results.length) throw new TypeError('Tool feedback does not close the reply');
  const byId = new Map(results.map((item) => [item.toolCallId, item]));
  if (results.some((item) => !calls.some((call) => call.id === item.toolCallId))) throw new TypeError('Feedback targets an unknown call');
  const content = reply.output.find((item) => item.kind === 'text')?.text ?? null;
  return fixed([
    { role: 'assistant', content, ...(reply.native.reasoningContent === undefined ? {} : { reasoning_content: reply.native.reasoningContent }), ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments.text } })) } : {}) },
    ...calls.map((call) => {
      const result = byId.get(call.id);
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: result.status, content: result.content }) };
    }),
  ]);
}

const deltaCall = z.strictObject({ index: count.max(maximumToolCalls - 1), id: identity.optional(), type: z.literal('function').optional(), function: z.strictObject({ name: z.string().optional(), arguments: z.string().optional() }).optional() });
const chunkSchema = z.strictObject({ id: identity, object: z.literal('chat.completion.chunk').optional(), created: count.optional(), model: identity, choices: z.array(z.strictObject({ index: z.literal(0), delta: z.strictObject({ role: z.literal('assistant').optional(), content: z.string().nullable().optional(), reasoning_content: z.string().optional(), tool_calls: z.array(deltaCall).optional() }), finish_reason: finishReason.nullable() })).max(1), usage: wireUsage.nullable().optional() });

/** Offline SSE aggregation, including UTF-8 and interleaved argument fragments. */
export function acceptReplyStream(parts) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let source = '';
  let size = 0;
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part;
    size += bytes.byteLength;
    if (size > 2 * 1024 * 1024) throw new TypeError('Tool stream exceeds byte limit');
    source += decoder.decode(bytes, { stream: true });
  }
  source += decoder.decode();
  let id;
  let model;
  let content = '';
  let hasContent = false;
  let reasoning = '';
  let hasReasoning = false;
  let reason;
  let reported;
  let done = false;
  const calls = new Map();
  const events = source.replaceAll('\r\n', '\n').split('\n\n');
  if (events.at(-1).trim() !== '') throw new TypeError('Tool stream ended inside an event');
  for (const event of events) {
    const lines = event.split('\n').filter((line) => line && !line.startsWith(':'));
    if (lines.length === 0) continue;
    if (done || lines.some((line) => !line.startsWith('data:'))) throw new TypeError('Invalid tool SSE framing');
    const data = lines.map((line) => line.slice(5).replace(/^ /u, '')).join('\n');
    if (data === '[DONE]') {
      if (!reason) throw new TypeError('Tool stream is missing its finish reason');
      done = true;
      continue;
    }
    const chunk = chunkSchema.parse(fixed(JSON.parse(data)));
    if (id !== undefined && (id !== chunk.id || model !== chunk.model)) throw new TypeError('Tool stream changed reply identity');
    id = chunk.id;
    model = chunk.model;
    if (chunk.usage != null) {
      if (reported !== undefined) throw new TypeError('Duplicate tool stream usage');
      reported = chunk.usage;
    }
    if (reason && chunk.choices.length) throw new TypeError('Tool stream continued after termination');
    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (delta.content != null) {
        content += delta.content;
        hasContent = true;
      }
      if (delta.reasoning_content !== undefined) {
        reasoning += delta.reasoning_content;
        hasReasoning = true;
      }
      for (const fragment of delta.tool_calls ?? []) {
        let call = calls.get(fragment.index);
        if (!call) {
          call = { id: '', type: 'function', function: { name: '', arguments: '' } };
          calls.set(fragment.index, call);
        }
        if (fragment.id !== undefined) {
          if (call.id) throw new TypeError('Duplicate streamed tool ID');
          call.id = fragment.id;
        }
        call.function.name += fragment.function?.name ?? '';
        call.function.arguments += fragment.function?.arguments ?? '';
      }
      if (choice.finish_reason !== null) reason = choice.finish_reason;
    }
  }
  if (!done || !reason || !id) throw new TypeError('Tool stream is incomplete');
  const indexes = [...calls.keys()].sort((a, b) => a - b);
  if (indexes.some((index, position) => index !== position)) throw new TypeError('Tool stream call indexes have gaps');
  return acceptReply({ id, model, choices: [{ index: 0, message: { role: 'assistant', content: hasContent ? content : null, ...(hasReasoning ? { reasoning_content: reasoning } : {}), ...(calls.size ? { tool_calls: indexes.map((index) => calls.get(index)) } : {}) }, finish_reason: reason }], usage: reported ?? null });
}
