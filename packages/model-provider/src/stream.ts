import { isRequestCancellation, ModelEmissionFailure, ProviderError } from './error.js';
import type { ModelReply } from './types.js';
import { acceptUsage } from './usage.js';
import { acceptWireReply } from './wire.js';
import { toolLimit } from './value.js';

/** A stream is complete only after its terminal choice and the provider's [DONE] marker. */
export async function readModelStream(response: Response, signal: AbortSignal, limit: number, emit?: (delta: string) => void): Promise<ModelReply> {
  if (!response.body) throw envelope();
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
    await response.body.cancel().catch(() => undefined);
    throw envelope();
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const completion = new ChatCompletionStream(signal, emit);
    const events = new ServerSentEvents((data) => completion.receive(data));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let chunk = await reader.read();
    while (!chunk.done && !completion.done) {
      signal.throwIfAborted();
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ProviderError('RESPONSE_LIMIT', 'Model response exceeds the configured byte limit');
      events.write(decoder.decode(chunk.value, { stream: true }));
      if (!completion.done) chunk = await reader.read();
    }
    signal.throwIfAborted();
    if (!completion.done) {
      events.write(decoder.decode());
      throw envelope();
    }
    return completion.result();
  } catch (error) {
    if (error instanceof ModelEmissionFailure) throw error;
    if (isRequestCancellation(error, signal)) throw signal.reason;
    if (error instanceof ProviderError) throw error;
    throw envelope();
  } finally {
    signal.removeEventListener('abort', abort);
    // [DONE] ends the protocol without requiring the HTTP producer to close first.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Only line framing belongs here; completion semantics remain with the consumer. */
class ServerSentEvents {
  #line = '';
  #skipLF = false;
  #data: string[] = [];
  #done = false;

  constructor(private readonly receive: (data: string) => boolean) {}

  write(text: string): void {
    let start = 0;
    for (let index = 0; index < text.length && !this.#done; index++) {
      const character = text[index];
      if (this.#skipLF) {
        this.#skipLF = false;
        if (character === '\n') {
          start = index + 1;
          continue;
        }
      }
      if (character !== '\n' && character !== '\r') continue;
      this.acceptLine(this.#line + text.slice(start, index));
      this.#line = '';
      this.#skipLF = character === '\r';
      start = index + 1;
    }
    if (!this.#done) this.#line += text.slice(start);
  }

  private acceptLine(line: string): void {
    if (line === '') {
      if (this.#data.length) this.#done = this.receive(this.#data.join('\n'));
      this.#data = [];
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    const value = colon === -1 ? '' : line.slice(colon + 1);
    this.#data.push(value.startsWith(' ') ? value.slice(1) : value);
  }
}

class ChatCompletionStream {
  #id: string | undefined;
  #model: string | undefined;
  #finishReason: string | undefined;
  #usage: ModelReply['usage'] = null;
  #wireUsage: unknown;
  #fragments: string[] = [];
  #hasContent = false;
  #reasoning: string[] = [];
  #hasReasoning = false;
  #calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  #done = false;

  constructor(
    private readonly signal: AbortSignal,
    private readonly emit?: (delta: string) => void,
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
    const value: unknown = JSON.parse(data);
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
          if (call.id) throw envelope();
          call.id = fragment.id;
        }
        if (record(fragment.function)) {
          const { name, arguments: args } = fragment.function;
          if ((name !== undefined && typeof name !== 'string') || (args !== undefined && typeof args !== 'string')) throw envelope();
          if (typeof name === 'string') call.function.name += name;
          if (typeof args === 'string') call.function.arguments += args;
        }
      }
    }
    if (typeof delta.content === 'string') this.#hasContent = true;
    if (typeof delta.content === 'string' && delta.content.length) {
      this.#fragments.push(delta.content);
      if (this.emit) {
        try {
          const returned: unknown = this.emit(delta.content);
          if ((typeof returned === 'object' && returned !== null) || typeof returned === 'function') {
            if ('then' in returned && typeof returned.then === 'function') {
              void Promise.resolve(returned).catch(() => undefined);
              throw new TypeError('Model preview consumer must be synchronous');
            }
          }
        } catch (failure) {
          throw new ModelEmissionFailure(failure);
        }
      }
      this.signal.throwIfAborted();
    }
    return false;
  }

  result(): ModelReply {
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
