import { parseModelJson, deliverModelConsumer, ProviderError } from './error.js';
import { readEventStream } from './sse.js';
import type { ChatCompletionsReply, ModelStreamProgress } from './types.js';
import { acceptUsage } from './usage.js';
import { acceptWireReply } from './wire.js';
import { toolLimit } from './value.js';

/** A stream is complete only after its terminal choice and the provider's [DONE] marker. */
export async function readModelStream(response: Response, signal: AbortSignal, limit: number, emit?: (delta: string) => void, progress?: (progress: ModelStreamProgress) => void, emitReasoning?: (delta: string) => void): Promise<ChatCompletionsReply> {
  return readEventStream(response, signal, limit, new ChatCompletionStream(signal, emit, progress, emitReasoning));
}

class ChatCompletionStream {
  #id: string | undefined;
  #model: string | undefined;
  #finishReason: string | undefined;
  #usage: ChatCompletionsReply['usage'] = null;
  #wireUsage: unknown;
  #fragments: string[] = [];
  #hasContent = false;
  #reasoning: string[] = [];
  #hasReasoning = false;
  #calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  #done = false;
  #progressKind: ModelStreamProgress['kind'] | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly emit?: (delta: string) => void,
    private readonly progress?: (progress: ModelStreamProgress) => void,
    private readonly emitReasoning?: (delta: string) => void,
  ) {}

  get done(): boolean {
    return this.#done;
  }

  receive(data: string): boolean {
    this.signal.throwIfAborted();
    if (data === '[DONE]') {
      if (!this.#id || !this.#model || !this.#finishReason) throw envelope();
      this.#done = true;
      return true;
    }
    const value: unknown = parseModelJson(data);
    if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.model !== 'string' || !value.model || !Array.isArray(value.choices)) throw envelope();
    if ((this.#id !== undefined && this.#id !== value.id) || (this.#model !== undefined && this.#model !== value.model) || value.error != null) throw envelope();
    this.#id = value.id;
    this.#model = value.model;
    const usage = acceptUsage(value.usage);
    if (usage && this.#usage) throw envelope();
    if (value.choices.length === 0) {
      if (!this.#finishReason || !usage) throw envelope();
      this.#usage = usage;
      this.#wireUsage = value.usage;
      return false;
    }
    if (this.#finishReason || value.choices.length !== 1) throw envelope();
    const choice: unknown = value.choices[0];
    if (!record(choice) || choice.index !== 0 || !record(choice.delta)) throw envelope();
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== 'assistant') throw envelope();
    if (delta.function_call != null || delta.refusal != null || choice.message != null) throw envelope();
    if (delta.reasoning_content != null && typeof delta.reasoning_content !== 'string') throw envelope();
    if (delta.content != null && typeof delta.content !== 'string') throw envelope();
    const finishReason = choice.finish_reason;
    if (finishReason != null && (typeof finishReason !== 'string' || !finishReason)) throw envelope();
    if (usage && !finishReason) throw envelope();
    if (typeof finishReason === 'string') this.#finishReason = finishReason;
    if (usage) {
      this.#usage = usage;
      this.#wireUsage = value.usage;
    }
    if (typeof delta.reasoning_content === 'string') {
      this.#reasoning.push(delta.reasoning_content);
      this.#hasReasoning = true;
    }
    let hasToolDelta = false;
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > toolLimit) throw envelope();
      for (const fragment of delta.tool_calls) {
        if (!record(fragment) || typeof fragment.index !== 'number' || !Number.isSafeInteger(fragment.index) || fragment.index < 0 || fragment.index >= toolLimit || (fragment.type !== undefined && fragment.type !== 'function') || (fragment.id !== undefined && (typeof fragment.id !== 'string' || !fragment.id)) || (fragment.function !== undefined && !record(fragment.function))) throw envelope();
        let call = this.#calls.get(fragment.index);
        if (!call) {
          call = { id: '', type: 'function', function: { name: '', arguments: '' } };
          this.#calls.set(fragment.index, call);
        }
        if (typeof fragment.id === 'string') {
          if (call.id || [...this.#calls.values()].some((existing) => existing.id === fragment.id)) throw envelope();
          call.id = fragment.id;
          hasToolDelta = true;
        }
        if (record(fragment.function)) {
          const { name, arguments: args } = fragment.function;
          if ((name !== undefined && typeof name !== 'string') || (args !== undefined && typeof args !== 'string')) throw envelope();
          if (typeof name === 'string') call.function.name += name;
          if (typeof args === 'string') call.function.arguments += args;
          if ((typeof name === 'string' && name.length > 0) || (typeof args === 'string' && args.length > 0)) hasToolDelta = true;
        }
      }
    }
    // Notify only after the entire chunk (including every tool fragment) is validated.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      this.reportProgress('reasoning');
      if (this.emitReasoning) deliverModelConsumer(() => this.emitReasoning!(delta.reasoning_content as string), 'Model reasoning preview consumer must be synchronous');
      this.signal.throwIfAborted();
    }
    if (hasToolDelta) this.reportProgress('tool-call');
    if (typeof delta.content === 'string' && delta.content.length) this.reportProgress('text');
    if (typeof delta.content === 'string') this.#hasContent = true;
    if (typeof delta.content === 'string' && delta.content.length) {
      this.#fragments.push(delta.content);
      if (this.emit) deliverModelConsumer(() => this.emit!(delta.content as string), 'Model preview consumer must be synchronous');
      this.signal.throwIfAborted();
    }
    return false;
  }

  private reportProgress(kind: ModelStreamProgress['kind']): void {
    if (this.#progressKind === kind) return;
    this.#progressKind = kind;
    if (this.progress) deliverModelConsumer(() => this.progress!(Object.freeze({ kind })), 'Model progress consumer must be synchronous');
    this.signal.throwIfAborted();
  }

  result(): ChatCompletionsReply {
    if (!this.#done || !this.#id || !this.#model || !this.#finishReason) throw envelope();
    const indexes = [...this.#calls.keys()].sort((left, right) => left - right);
    if (indexes.some((index, position) => index !== position)) throw envelope();
    return acceptWireReply({ id: this.#id, model: this.#model, choices: [{ index: 0, message: { role: 'assistant', content: this.#hasContent || !this.#calls.size ? this.#fragments.join('') : null, ...(this.#hasReasoning ? { reasoning_content: this.#reasoning.join('') } : {}), ...(this.#calls.size ? { tool_calls: indexes.map((index) => this.#calls.get(index)) } : {}) }, finish_reason: this.#finishReason }], usage: this.#wireUsage });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envelope(): ProviderError {
  return new ProviderError('ENVELOPE', 'Model response is not a supported Chat Completions stream');
}
