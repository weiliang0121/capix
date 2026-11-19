import { validMessagesCounts } from './messages-contract.js';
import { parseModelJson, deliverModelConsumer, ModelProtocolIssue, ProviderError } from './error.js';
import { acceptMessagesReply, messagesIdentity, readMessagesUsage, readMessagesBlock } from './messages-wire.js';
import type { MessagesBinding } from './messages-history.js';
import type { AnthropicMessagesReply, ModelControls, ModelStreamProgress } from './types.js';
import { identity, record } from './value.js';

/** Anthropic emits sequential, indexed content blocks followed by cumulative message deltas. */
export class MessagesStream {
  #id?: string;
  #model?: string;
  #reason?: string;
  #usage: Record<string, unknown> = {};
  #blocks: Record<string, unknown>[] = [];
  #active?: ReturnType<typeof readMessagesBlock>;
  #partial: string[] = [];
  #inMessageDelta = false;
  #progress?: ModelStreamProgress['kind'];
  done = false;

  constructor(
    private readonly binding: MessagesBinding & { prefixSha256: string },
    private readonly signal: AbortSignal,
    private readonly controls: ModelControls,
  ) {}

  receive(data: string, event: string): boolean {
    this.signal.throwIfAborted();
    const value: unknown = parseModelJson(data);
    if (!record(value) || typeof value.type !== 'string' || (event && event !== value.type)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-event');
    switch (value.type) {
      case 'ping':
        return false;
      case 'error':
        // An explicit upstream failure terminates this attempt. Only transport interruption is retryable here.
        throw new ProviderError('HTTP', 'Messages endpoint returned a stream error');
      case 'message_start': {
        const message = value.message;
        if (this.#id) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
        if (!record(message) || message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length || message.stop_reason != null || message.error != null) throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
        this.#id = messagesIdentity(message.id, 'id');
        this.#model = messagesIdentity(message.model, 'model');
        this.mergeUsage(message.usage);
        // Initial output counts precede generation and cannot establish the final total.
        delete this.#usage.output_tokens;
        return false;
      }
      case 'content_block_start': {
        if (!this.#id || this.#inMessageDelta || this.#active || value.index !== this.#blocks.length) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
        const block = readMessagesBlock(value.content_block);
        if (block.type === 'text') this.preview('text', block.text);
        if (block.type === 'thinking') this.preview('reasoning', block.thinking);
        if (block.type === 'tool_use') this.report('tool-call');
        this.#active = block;
        this.#partial = [];
        return false;
      }
      case 'content_block_delta':
        if (!this.#active || value.index !== this.#blocks.length) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
        if (!record(value.delta)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-event');
        this.blockDelta(this.#active, value.delta);
        return false;
      case 'content_block_stop': {
        const block = this.#active;
        if (!block || value.index !== this.#blocks.length) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
        if (block.type === 'tool_use' && this.#partial.length) {
          let input: unknown;
          try {
            input = JSON.parse(this.#partial.join(''));
          } catch {
            throw new ModelProtocolIssue('ENVELOPE', 'invalid-block');
          }
          if (!record(input)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-block');
          block.input = input;
        }
        if (block.type === 'thinking' && !block.signature?.trim()) throw new ModelProtocolIssue('ENVELOPE', 'missing-thinking-signature');
        this.#blocks.push(block);
        this.#active = undefined;
        return false;
      }
      case 'message_delta': {
        if (!this.#id || this.#reason || this.#active) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
        if (!record(value.delta)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-event');
        this.#inMessageDelta = true;
        const reason = value.delta.stop_reason;
        if (reason != null) {
          identity(reason);
          this.#reason = reason;
        }
        this.mergeUsage(value.usage);
        return false;
      }
      case 'message_stop':
        if (this.#active || !this.#reason) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
        this.done = true;
        return true;
      default:
        throw new ModelProtocolIssue('ENVELOPE', 'invalid-event');
    }
  }

  private mergeUsage(usage: unknown): void {
    Object.assign(this.#usage, readMessagesUsage(usage));
    if (!validMessagesCounts(this.#usage)) throw new ModelProtocolIssue('ENVELOPE', 'invalid-usage');
  }

  private blockDelta(block: ReturnType<typeof readMessagesBlock>, delta: Record<string, unknown>): void {
    if (block.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
      block.text += delta.text;
      this.preview('text', delta.text);
    } else if (block.type === 'thinking' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      if (block.signature) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
      block.thinking += delta.thinking;
      this.preview('reasoning', delta.thinking);
    } else if (block.type === 'thinking' && delta.type === 'signature_delta' && typeof delta.signature === 'string') {
      block.signature = (block.signature ?? '') + delta.signature;
    } else if (block.type === 'tool_use' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && Object.keys(block.input).length === 0) {
      if (delta.partial_json) this.#partial.push(delta.partial_json);
    } else throw new ModelProtocolIssue('ENVELOPE', 'invalid-event');
  }

  private report(kind: ModelStreamProgress['kind']): void {
    if (this.#progress === kind) return;
    this.#progress = kind;
    if (this.controls.progress) deliverModelConsumer(() => this.controls.progress!(Object.freeze({ kind })), 'Model progress consumer must be synchronous');
    this.signal.throwIfAborted();
  }

  private preview(kind: 'text' | 'reasoning', text: string): void {
    if (!text) return;
    this.report(kind);
    const callback = kind === 'text' ? this.controls.emit : this.controls.emitReasoning;
    if (callback) deliverModelConsumer(() => callback(text), 'Model preview consumer must be synchronous');
    this.signal.throwIfAborted();
  }

  result(): AnthropicMessagesReply {
    if (!this.done) throw new ModelProtocolIssue('ENVELOPE', 'missing-terminal');
    return acceptMessagesReply({ type: 'message', role: 'assistant', id: this.#id, model: this.#model, stop_reason: this.#reason, content: this.#blocks, usage: this.#usage }, this.binding);
  }
}
