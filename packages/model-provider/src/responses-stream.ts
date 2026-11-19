import { parseModelJson, deliverModelConsumer, ProviderError } from './error.js';
import { acceptResponsesReply, checkResponsesFunctionCall, reconcileResponsesItem, responsesEnvelope, responsesOutputItem } from './responses-reply.js';
import type { ResponsesSource } from './responses-wire.js';
import type { ModelControls, ModelStreamProgress, OpenAIResponsesReply } from './types.js';
import { count, identity, record } from './value.js';

type Item = Record<string, unknown>;
interface PendingItem {
  readonly added: Item;
  readonly parts: Map<string, PendingPart>;
  finished?: Item;
}
interface PendingPart {
  readonly field: 'content' | 'summary' | 'arguments';
  readonly index: number;
  readonly type: string;
  readonly fragments: string[];
  textDone: boolean;
  partDone: boolean;
}

/** Preview only indexed deltas. A terminal response supplies the one authoritative reply. */
export class ResponsesStream {
  #id?: string;
  #model?: string;
  #sequence?: number;
  #items: PendingItem[] = [];
  #reply?: OpenAIResponsesReply;
  #progress?: ModelStreamProgress['kind'];

  constructor(
    private readonly binding: ResponsesSource,
    private readonly signal: AbortSignal,
    private readonly controls: ModelControls,
  ) {}

  get done(): boolean {
    return this.#reply !== undefined;
  }

  receive(data: string, event: string): boolean {
    this.signal.throwIfAborted();
    const value: unknown = parseModelJson(data);
    if (!record(value) || typeof value.type !== 'string' || (event && event !== value.type)) throw responsesEnvelope();
    if (value.type === 'error' || value.type === 'response.failed') throw new ProviderError('HTTP', 'Responses endpoint returned a stream error');
    if (!count(value.sequence_number) || (this.#sequence !== undefined && value.sequence_number !== this.#sequence + 1)) throw responsesEnvelope();
    this.#sequence = value.sequence_number;
    if (value.type === 'response.created') {
      const source = value.response;
      if (this.#id || !record(source) || source.object !== 'response' || (source.status !== 'in_progress' && source.status !== 'queued') || source.error != null || !Array.isArray(source.output) || source.output.length) throw responsesEnvelope();
      identity(source.id);
      identity(source.model);
      this.#id = source.id;
      this.#model = source.model;
      return false;
    }
    if (!this.#id) throw responsesEnvelope();
    switch (value.type) {
      case 'response.queued':
      case 'response.in_progress':
      case 'response.incomplete':
      case 'response.completed': {
        const source = value.response;
        if (!record(source) || source.object !== 'response' || source.id !== this.#id || source.model !== this.#model || value.type !== 'response.' + String(source.status) || source.error != null) throw responsesEnvelope();
        if (source.status === 'queued' || source.status === 'in_progress') return false;
        if (!Array.isArray(source.output) || source.output.length !== this.#items.length) throw responsesEnvelope();
        const output = source.output.map((raw: unknown, index: number) => {
          const item = responsesOutputItem(raw);
          const pending = this.#items[index]!;
          this.checkItem(pending, item);
          const finished = pending.finished;
          if (!finished) {
            if (source.status !== 'incomplete') throw responsesEnvelope();
            return item;
          }
          return reconcileResponsesItem(item, finished);
        });
        this.#reply = acceptResponsesReply({ ...source, output }, this.binding);
        return true;
      }
      case 'response.output_item.added': {
        const item = responsesOutputItem(value.item);
        if (value.output_index !== this.#items.length || !['message', 'reasoning', 'function_call'].includes(String(item.type))) throw responsesEnvelope();
        identity(item.id);
        if (item.type === 'message' && (item.role !== 'assistant' || !Array.isArray(item.content))) throw responsesEnvelope();
        if (item.type === 'reasoning' && !Array.isArray(item.summary)) throw responsesEnvelope();
        if (item.type === 'function_call') checkResponsesFunctionCall(item);
        this.#items.push({ added: item, parts: new Map() });
        return false;
      }
    }
    if (!count(value.output_index)) throw responsesEnvelope();
    const pending = this.#items[value.output_index];
    if (!pending || pending.finished) throw responsesEnvelope();
    if (value.type === 'response.output_item.done') {
      const finished = responsesOutputItem(value.item);
      this.checkItem(pending, finished);
      pending.finished = finished;
    } else {
      if (value.item_id !== pending.added.id) throw responsesEnvelope();
      this.partEvent(pending, value, value.type);
    }
    return false;
  }

  private checkItem(pending: PendingItem, item: Item): void {
    const added = pending.added;
    if (item.type !== added.type || item.id !== added.id || (item.type === 'function_call' && (item.call_id !== added.call_id || item.name !== added.name))) throw responsesEnvelope();
    for (const part of pending.parts.values()) {
      let text = item.arguments;
      if (part.field !== 'arguments') {
        const parts = item[part.field];
        const material: unknown = Array.isArray(parts) ? parts[part.index] : undefined;
        if (!record(material) || material.type !== part.type) throw responsesEnvelope();
        text = material[part.type === 'refusal' ? 'refusal' : 'text'];
      }
      if (text !== part.fragments.join('')) throw responsesEnvelope();
    }
  }

  private partEvent(pending: PendingItem, event: Item, type: string): void {
    const match = /^response\.(content_part|reasoning_summary_part|reasoning_summary_text|reasoning_text|output_text|refusal|function_call_arguments)\.(added|delta|done)$/u.exec(type);
    if (!match) throw responsesEnvelope();
    const family = match[1]!;
    const action = match[2]!;
    const partEvent = family.endsWith('_part');
    const summary = family.startsWith('reasoning_summary');
    const args = family === 'function_call_arguments';
    const index = args ? 0 : summary ? event.summary_index : event.content_index;
    if (!count(index)) throw responsesEnvelope();
    const field = args ? 'arguments' : summary ? 'summary' : 'content';
    const key = field + '/' + index;
    const material = event.part;
    const partType = partEvent && record(material) ? material.type : family === 'reasoning_summary_text' ? 'summary_text' : family;
    if ((partEvent && action === 'delta') || (!partEvent && action === 'added')) throw responsesEnvelope();
    switch (pending.added.type) {
      case 'function_call':
        if (!args || (event.name !== undefined && event.name !== pending.added.name)) throw responsesEnvelope();
        break;
      case 'reasoning':
        if (partType !== (summary ? 'summary_text' : 'reasoning_text')) throw responsesEnvelope();
        break;
      case 'message':
        if (summary || (partType !== 'refusal' && partType !== 'output_text')) throw responsesEnvelope();
        break;
    }
    const part = pending.parts.get(key);
    if (part && (part.type !== partType || part.partDone)) throw responsesEnvelope();
    const textField = partType === 'refusal' ? 'refusal' : args ? 'arguments' : 'text';
    const text = partEvent && record(material) ? material[textField] : action === 'delta' ? event.delta : event[textField];
    if (typeof text !== 'string' || typeof partType !== 'string') throw responsesEnvelope();
    if (action === 'added') {
      if (part) throw responsesEnvelope();
      pending.parts.set(key, { field, index, type: partType, fragments: [text], partDone: false, textDone: false });
      return;
    }
    // Function arguments do not use content_part.added. Reasoning text may arrive directly.
    if (!part && !args && partType !== 'reasoning_text') throw responsesEnvelope();
    const current: PendingPart = part ?? { field, index, type: partType, fragments: args ? [String(pending.added.arguments)] : [], partDone: false, textDone: false };
    pending.parts.set(key, current);
    if (action === 'delta') {
      if (current.textDone) throw responsesEnvelope();
      current.fragments.push(text);
      if (text && partType !== 'refusal') this.preview(args ? 'tool-call' : partType === 'output_text' ? 'text' : 'reasoning', text);
    } else {
      if (!part && !current.fragments.length) current.fragments.push(text);
      if (current.fragments.join('') !== text || (!partEvent && current.textDone)) throw responsesEnvelope();
      if (partEvent) current.partDone = true;
      else current.textDone = true;
    }
  }

  private preview(kind: ModelStreamProgress['kind'], delta: string): void {
    if (this.#progress !== kind) {
      this.#progress = kind;
      if (this.controls.progress) deliverModelConsumer(() => this.controls.progress!(Object.freeze({ kind })), 'Model progress consumer must be synchronous');
      this.signal.throwIfAborted();
    }
    const consumer = kind === 'text' ? this.controls.emit : kind === 'reasoning' ? this.controls.emitReasoning : undefined;
    if (consumer) deliverModelConsumer(() => consumer(delta), 'Model preview consumer must be synchronous');
    this.signal.throwIfAborted();
  }

  result(): OpenAIResponsesReply {
    if (!this.#reply) throw responsesEnvelope();
    return this.#reply;
  }
}
