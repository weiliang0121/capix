import { parseModelJson, deliverModelConsumer, ModelProtocolIssue } from './error.js';
import { finishGeminiReply, geminiFrame } from './gemini-reply.js';
import type { GeminiSource } from './gemini-wire.js';
import type { GeminiGenerateContentReply, ModelControls, ModelStreamProgress } from './types.js';

/** Each event carries complete Parts. Preserve their order and signature boundaries. */
export class GeminiStream {
  #parts: ReturnType<typeof geminiFrame>['parts'] = [];
  #id?: string;
  #model?: string;
  #progress?: ModelStreamProgress['kind'];
  #terminal?: ReturnType<typeof geminiFrame>;
  #usage: GeminiGenerateContentReply['usage'] = null;

  constructor(
    private readonly binding: GeminiSource,
    private readonly signal: AbortSignal,
    private readonly controls: ModelControls,
  ) {}

  get done(): boolean {
    return this.#terminal !== undefined && this.#usage !== null;
  }

  get canFinishAtEof(): boolean {
    return this.#terminal !== undefined;
  }

  receive(data: string, event: string): boolean {
    this.signal.throwIfAborted();
    if (this.done) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
    if (event && event !== 'message' && event !== 'error') throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
    const frame = geminiFrame(parseModelJson(data));
    if (event === 'error') throw new ModelProtocolIssue('ENVELOPE', 'invalid-envelope');
    if (frame.id !== undefined) {
      if (this.#id !== undefined && frame.id !== this.#id) throw new ModelProtocolIssue('ENVELOPE', 'inconsistent-stream-identity');
      this.#id = frame.id;
    }
    if (frame.model !== undefined) {
      if (this.#model !== undefined && frame.model !== this.#model) throw new ModelProtocolIssue('ENVELOPE', 'inconsistent-stream-identity');
      this.#model = frame.model;
    }
    if (this.#terminal && (frame.hasCandidate || frame.promptBlocked)) throw new ModelProtocolIssue('ENVELOPE', 'event-order');
    for (const part of frame.parts) {
      this.#parts.push(part);
      if (part.functionCall) this.report('tool-call');
      else if (part.text) {
        this.report(part.thought ? 'reasoning' : 'text');
        const callback = part.thought ? this.controls.emitReasoning : this.controls.emit;
        if (callback) deliverModelConsumer(() => callback(part.text!), 'Model preview consumer must be synchronous');
        this.signal.throwIfAborted();
      }
    }
    if (frame.reason) this.#terminal = frame;
    // Intermediate counters can cover only a prefix of the generated output.
    if (this.#terminal && frame.usage !== null) this.#usage = frame.usage;
    return this.done;
  }

  private report(kind: ModelStreamProgress['kind']): void {
    if (kind === this.#progress) return;
    this.#progress = kind;
    if (this.controls.progress) deliverModelConsumer(() => this.controls.progress!({ kind }), 'Model progress consumer must be synchronous');
    this.signal.throwIfAborted();
  }

  result(): GeminiGenerateContentReply {
    if (!this.#terminal) throw new ModelProtocolIssue('ENVELOPE', 'missing-terminal');
    return finishGeminiReply({ ...this.#terminal, id: this.#id, model: this.#model, parts: this.#parts, usage: this.#usage }, this.binding);
  }
}
