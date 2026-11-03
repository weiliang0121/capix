import type { AnswerPreviewChange, AnswerPreviewSnapshot, ConversationAdmission, ConversationFailure, ConversationSubmissionBaseline, ConversationSubmissionChange, ConversationSubmissionFrame, ConversationSubmissionSnapshot, TranscriptEvent } from '@capix/protocol';
import type { RunnerObservation, RunnerOutput } from '@capix/server-runtime';
import type { ConversationEvents } from './events.js';

export interface ConversationRunner {
  readonly isRunning: boolean;
  readonly output: RunnerOutput<string, string>;
  readonly observation: RunnerObservation;
  run(input: string): Promise<string>;
  cancel(reason?: unknown): boolean;
}

export class ConversationHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** One connection-independent service delivery, not a second invocation state machine. */
export class Submission {
  #state: ConversationSubmissionSnapshot;
  #preview?: AnswerPreviewSnapshot;
  #previewBytes = 0;
  readonly #listeners = new Set<(frame: ConversationSubmissionFrame) => void>();
  entryId?: string;
  contextId?: string;
  settledStatus?: 'succeeded' | 'failed' | 'cancelled';

  constructor(
    conversationId: string,
    readonly id: string,
    readonly input: string,
    readonly previewLimit: number,
  ) {
    this.#state = Object.freeze({ conversationId, submissionId: id, revision: 0, executions: Object.freeze([]), integrity: Object.freeze({ status: 'complete' }) });
  }

  get baseline(): ConversationSubmissionBaseline {
    return Object.freeze({ type: 'baseline', submission: this.#state, ...(this.#preview ? { preview: this.#preview } : {}) });
  }
  get ended(): boolean {
    return Boolean(this.#state.result) || this.#state.integrity.status === 'incomplete';
  }
  get result(): ConversationSubmissionSnapshot['result'] {
    return this.#state.result;
  }

  connect(receive: (frame: ConversationSubmissionFrame) => void): () => void {
    this.#listeners.add(receive);
    try {
      receive(this.baseline);
    } catch (error) {
      this.#listeners.delete(receive);
      throw error;
    }
    return () => this.#listeners.delete(receive);
  }

  update(change: Pick<ConversationSubmissionChange, 'input' | 'answer' | 'executions' | 'result' | 'cancelRequested' | 'integrity'> & { readonly admission?: ConversationAdmission }): void {
    if (this.#state.result) return;
    const fromRevision = this.#state.revision;
    const revision = fromRevision + 1;
    this.#state = Object.freeze({ ...this.#state, ...change, revision, executions: change.executions ? Object.freeze([...this.#state.executions, ...change.executions]) : this.#state.executions });
    this.publish(Object.freeze({ type: 'submission', conversationId: this.#state.conversationId, submissionId: this.id, fromRevision, revision, change }));
  }

  delta(text: string): void {
    if (!text || this.ended || this.#preview?.state === 'discarded' || this.#preview?.state === 'committed') return;
    if (!this.#preview) this.preview({ kind: 'started', generation: 1, revision: 1 });
    this.#previewBytes += Buffer.byteLength(text);
    if (this.#previewBytes > this.previewLimit) {
      this.discard('failed');
      return;
    }
    this.preview({ kind: 'appended', generation: 1, revision: this.#preview!.revision + 1, offset: this.#preview!.text.length, text });
  }

  content(event: TranscriptEvent): void {
    if (event.origin?.contextId !== this.contextId || event.change.kind !== 'messages-appended') return;
    const { start, messages } = event.change;
    const message = messages[0];
    if (messages.length !== 1 || !message) throw new Error('Conversation Scene must append one message at a time');
    if (message.role === 'user' && !this.#state.input) {
      this.update({ input: { transcriptId: event.transcriptId, start, end: start + 1, revision: event.revision } });
    } else if (message.role === 'assistant' && this.#state.input && !this.#state.answer) {
      const answer = Object.freeze({ transcriptId: event.transcriptId, index: start });
      this.update({ answer });
      if (this.#preview?.state === 'streaming') this.preview({ kind: 'received', generation: 1, revision: this.#preview.revision + 1 });
      if (this.#preview?.state === 'received') this.preview({ kind: 'committed', generation: 1, revision: this.#preview.revision + 1, message: answer, consistency: this.#preview.text === message.content ? 'complete' : message.content.startsWith(this.#preview.text) ? 'prefix' : 'mismatch' });
    } else throw new Error('Conversation append order does not match submission');
  }

  discard(reason: 'failed' | 'cancelled'): void {
    if (this.#preview && (this.#preview.state === 'streaming' || this.#preview.state === 'received')) this.preview({ kind: 'discarded', generation: 1, revision: this.#preview.revision + 1, reason });
  }

  invalidate(): void {
    if (this.#state.integrity.status === 'incomplete') return;
    this.update({ integrity: { status: 'incomplete', error: { code: 'SOURCE_INCOMPLETE', message: '提交反馈来源不完整，请核对正式消息。' } } });
  }

  private preview(change: AnswerPreviewChange): void {
    const previous = this.#preview;
    if (change.kind === 'started') this.#preview = Object.freeze({ generation: change.generation, revision: change.revision, text: '', state: 'streaming' });
    else if (previous) {
      if (change.kind === 'appended') this.#preview = Object.freeze({ ...previous, revision: change.revision, text: previous.text + change.text });
      else if (change.kind === 'received') this.#preview = Object.freeze({ ...previous, revision: change.revision, state: 'received' });
      else if (change.kind === 'committed') this.#preview = Object.freeze({ ...previous, revision: change.revision, state: 'committed', message: change.message, consistency: change.consistency });
      else this.#preview = Object.freeze({ ...previous, revision: change.revision, state: 'discarded', reason: change.reason });
    }
    this.publish({ type: 'answer', conversationId: this.#state.conversationId, submissionId: this.id, change });
  }

  private publish(frame: ConversationSubmissionFrame): void {
    for (const receive of [...this.#listeners]) {
      if (this.#listeners.has(receive)) {
        try {
          receive(frame);
        } catch {
          this.#listeners.delete(receive);
        }
      }
    }
  }
}

/** Retained feedback and transport ownership; execution itself remains in Runner. */
export class ConversationSubmissions {
  readonly #items = new Map<string, Submission>();
  readonly #seen = new Set<string>();
  readonly #dispose: (() => void)[] = [];
  #current?: Submission;
  #running?: Promise<void>;
  #closed = false;

  constructor(
    readonly runner: ConversationRunner,
    readonly events: ConversationEvents,
    readonly assertAvailable: () => void = () => {},
    readonly retention = 64,
    readonly previewLimit = 256 * 1024,
  ) {
    this.#dispose.push(
      events.subscribe((event) => {
        try {
          this.#current?.content(event);
        } catch {
          this.#current?.invalidate();
        }
      }),
    );
    this.#dispose.push(events.failed(() => this.#current?.invalidate()));
    this.#dispose.push(
      runner.output.subscribe({
        receive: (event) => {
          if (this.#current?.entryId === event.entryId && event.kind === 'delta') this.#current.delta(event.delta);
        },
        failed: () => {
          this.#current?.invalidate();
          return undefined;
        },
      }),
    );
    this.#dispose.push(
      runner.observation.subscribe({
        receive: (event) => {
          const current = this.#current;
          if (!current || event.source !== 'entry') return;
          if (event.fact.kind === 'requested' && !current.entryId) current.entryId = event.entryId;
          if (current.entryId !== event.entryId) return;
          if (event.fact.kind === 'attached') {
            current.contextId = event.fact.identity.contextId;
            current.update({ executions: [{ contextId: current.contextId }] });
          }
          if (event.fact.kind === 'settled') current.settledStatus = event.fact.status;
        },
        failed: () => {
          this.#current?.invalidate();
          return undefined;
        },
      }),
    );
  }

  get conversationId(): string {
    return this.events.transcript.id;
  }
  get active(): ConversationSubmissionBaseline | undefined {
    return this.#current?.baseline;
  }
  admission(): ConversationAdmission {
    const identity = { conversationId: this.conversationId, transcriptId: this.events.transcript.id };
    try {
      this.assertAvailable();
    } catch {
      return { ...identity, status: 'unavailable', error: { code: 'CONTENT_UNAVAILABLE', message: '内容存储不可用，不能接纳新消息。' } };
    }
    if (this.#closed || !this.events.available || this.#seen.size >= 4096) return { ...identity, status: 'unavailable', error: { code: 'SERVICE_UNAVAILABLE', message: '当前服务不能接纳新消息。' } };
    return { ...identity, status: this.#current || this.runner.isRunning ? 'busy' : 'ready' };
  }

  read(id: string): Submission {
    const item = this.#items.get(id);
    if (!item) throw new ConversationHttpError('SUBMISSION_UNAVAILABLE', '当前进程已不再保留这次提交，不能据此判断其执行结果。', 404);
    return item;
  }

  submit(id: string, input: string): Submission {
    if (this.#seen.has(id)) {
      const item = this.#items.get(id);
      if (item) {
        if (item.input !== input) throw new ConversationHttpError('SUBMISSION_EXISTS', '提交身份已用于其他输入。', 409);
        return item;
      }
      return this.read(id);
    }
    const admission = this.admission();
    const current = new Submission(this.conversationId, id, input, this.previewLimit);
    if (this.#seen.size < 4096) {
      this.#seen.add(id);
      for (const [key, item] of this.#items) {
        if (this.#items.size < this.retention) break;
        if (item !== this.#current) this.#items.delete(key);
      }
      this.#items.set(id, current);
    }
    if (admission.status !== 'ready') {
      current.update({ admission, result: { status: 'rejected', error: admission.status === 'busy' ? { code: 'RUNTIME_BUSY', message: '当前对话正在处理，请等待结束。' } : admission.error, ...(admission.status === 'busy' ? { retry: 'admission' as const } : {}) } });
      return current;
    }
    this.#current = current;
    current.update({ admission: this.admission() });
    const work = this.execute(current, input);
    this.#running = work;
    void work.finally(() => {
      if (this.#running === work) this.#running = undefined;
    });
    return current;
  }

  cancel(id: string): Submission {
    const current = this.read(id);
    if (current === this.#current && !current.result) {
      if (this.runner.cancel()) current.update({ cancelRequested: true });
    }
    return current;
  }

  stop(): void {
    this.#closed = true;
    if (this.#current) this.cancel(this.#current.id);
  }
  async settled(): Promise<void> {
    await this.#running;
  }
  close(): void {
    this.stop();
    for (const dispose of this.#dispose.splice(0)) dispose();
  }

  private async execute(current: Submission, input: string): Promise<void> {
    let result: NonNullable<ConversationSubmissionSnapshot['result']>;
    try {
      await this.runner.run(input);
      result = { status: 'completed' };
    } catch {
      result = current.settledStatus === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', error: failure() };
      if (result.status === 'cancelled' && !current.baseline.submission.cancelRequested) current.update({ cancelRequested: true });
      current.discard(result.status === 'cancelled' ? 'cancelled' : 'failed');
    }
    if (this.#current === current) this.#current = undefined;
    current.update({ result, admission: this.admission() });
  }
}

function failure(): ConversationFailure {
  return Object.freeze({ code: 'CONVERSATION_FAILED', message: '本次处理未完成，已保存内容保留；可查看调用记录。' });
}
