import { publishFact, type ChangeProvenance } from '../observation/publish.js';
import type { EventConsumer } from '../observation/observer.js';
import { randomUUID } from 'node:crypto';
import { isArray, isSafeInteger } from 'es-toolkit/compat';
import { isNonBlankString } from '../value/string.js';
import { isObject } from '../value/object.js';
import { MessageRef, TranscriptRangeRef } from './ref.js';
import type { Message } from '@capix/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import { createTranscriptEvent, type TranscriptEvent } from './event.js';
import type { ProgressChannel } from '../progress/channel.js';
import type { TranscriptAppendProgress } from './progress.js';
import type { TranscriptCommit, TranscriptPersistence, TranscriptState } from './persistence.js';
import type { TranscriptAppendOperation, TranscriptAppendReceipt, TranscriptAppendState, TranscriptFixedAppend } from './append.js';
import { RuntimeError } from '../errors/error.js';

export interface TranscriptOptions {
  observation?: EventConsumer<TranscriptEvent>;
  changes?: ChangeCapture<TranscriptEvent>;
  persistence?: TranscriptPersistence;
}

export interface TranscriptAppendOptions extends ChangeProvenance<TranscriptEvent> {
  readonly progress?: ProgressChannel<TranscriptAppendProgress>;
}

/** Original accepted messages, including the current input; independent of execution records. */
export class Transcript {
  #id: string = randomUUID();
  readonly #observation?: EventConsumer<TranscriptEvent>;
  #mutating = false;
  readonly #changes?: ChangeCapture<TranscriptEvent>;
  readonly #persistence?: TranscriptPersistence;
  #revision = 0;
  readonly #messages: Readonly<Message>[] = [];
  readonly #starts: number[] = [0];
  readonly #appends = new Map<string, TranscriptAppendState>();

  constructor(messages: readonly Message[] = [], options: TranscriptOptions = {}) {
    this.#observation = options.observation;
    this.#changes = options.changes;
    this.#persistence = options.persistence;
    if (!isArray(messages)) throw new TypeError('消息集合必须是数组。');
    this.append(...messages);
  }

  get id(): string {
    return this.#id;
  }

  /** Hydration is silent: it neither submits persistence writes nor replays accepted facts. */
  static restore(state: TranscriptState, options: TranscriptOptions = {}): Transcript {
    if (!isObject(state) || !isNonBlankString(state.id) || !isArray(state.messages) || !isArray(state.starts)) throw new TypeError('Invalid persisted transcript');
    const messages = Array.from(state.messages, (message) => Transcript.accept(message));
    const starts = Array.from(state.starts);
    if (!starts.length || starts[0] !== 0 || starts.some((start, index) => !isSafeInteger(start) || start < 0 || (index > 0 && (start <= starts[index - 1]! || start >= messages.length)))) throw new TypeError('Invalid persisted transcript segments');
    const minimumRevision = messages.length ? starts.length : 0;
    const maximumRevision = messages.length + starts.length - 1;
    if (!isSafeInteger(state.revision) || state.revision < minimumRevision || state.revision > maximumRevision) throw new TypeError('Invalid persisted transcript revision');
    const transcript = new Transcript([], options);
    transcript.#id = state.id;
    transcript.#revision = state.revision;
    transcript.#starts.length = 0;
    for (const start of starts) transcript.#starts.push(start);
    for (const message of messages) transcript.#messages.push(message);
    if (state.appends !== undefined) {
      if (!isArray(state.appends)) throw new TypeError('Invalid persisted transcript append operations');
      let previousEnd = 0;
      let previousRevision = 0;
      for (const saved of state.appends) {
        if (!isObject(saved) || !isObject(saved.receipt)) throw new TypeError('Invalid persisted transcript append receipt');
        const request = transcript.acceptFixed(saved.request);
        const value = saved.receipt;
        if (value.transcriptId !== transcript.id || !isSafeInteger(value.start) || value.start < previousEnd || !isSafeInteger(value.count) || value.count !== request.messages.length || value.start + value.count > messages.length || !isSafeInteger(value.revision) || value.revision <= previousRevision || value.revision > state.revision) throw new TypeError('Invalid persisted transcript append receipt');
        if (!transcript.matchesMessages(value.start, request.messages)) throw new TypeError('Persisted transcript append does not match messages');
        const key = operationKey(request.operation);
        if (transcript.#appends.has(key)) throw new TypeError('Duplicate persisted transcript append operation');
        const receipt = Object.freeze({ transcriptId: transcript.id, start: value.start, count: value.count, revision: value.revision });
        transcript.#appends.set(key, Object.freeze({ request, receipt }));
        previousEnd = value.start + value.count;
        previousRevision = value.revision;
      }
    }
    return transcript;
  }

  exportState(): TranscriptState {
    return Object.freeze({ id: this.id, revision: this.#revision, starts: Object.freeze([...this.#starts]), messages: Object.freeze([...this.#messages]), ...(this.#appends.size ? { appends: Object.freeze([...this.#appends.values()]) } : {}) });
  }

  get length(): number {
    return this.#messages.length;
  }

  /** Local order of completed append/segment changes, not a delivery cursor. */
  get revision(): number {
    return this.#revision;
  }

  get activeStart(): number {
    return this.#starts.at(-1)!;
  }

  /** Segment boundaries share immutable messages and preserve absolute indexes. */
  segments(): readonly TranscriptRangeRef[] {
    return this.#starts.map((start, index) => new TranscriptRangeRef(this, start, this.#starts[index + 1] ?? this.length));
  }

  startSegment(start: number, provenance: ChangeProvenance<TranscriptEvent> = {}): void {
    this.enterMutation();
    try {
      if (!isSafeInteger(start) || start <= this.activeStart || start >= this.length) throw new RangeError('New segment must start inside the active range');
      const previousStart = this.activeStart;
      const end = this.length;
      const event = createTranscriptEvent(this.id, this.nextRevision(), { kind: 'segment-started', previousStart, start, end }, provenance.origin);
      this.commit(Object.freeze({ kind: 'start-segment', transcriptId: this.id, expectedRevision: this.#revision, revision: event.revision, start }));
      this.#starts.push(start);
      this.#revision = event.revision;
      this.capture(event, provenance.observation);
    } finally {
      this.#mutating = false;
    }
  }

  append(...messages: readonly Message[]): void {
    this.appendFrom(messages);
  }

  appendFrom(messages: readonly Message[], provenance: TranscriptAppendOptions = {}): void {
    this.enterMutation();
    try {
      if (!isArray(messages)) throw new TypeError('消息集合必须是数组。');
      const accepted = Object.freeze(Array.from(messages, (message) => Transcript.accept(message)));
      if (!accepted.length) return;
      this.appendAccepted(accepted, provenance);
    } finally {
      this.#mutating = false;
    }
  }

  /** Confirm an exact fixed request. Absence is meaningful only within this authoritative entity. */
  confirmFixed(value: TranscriptFixedAppend): TranscriptAppendReceipt | undefined {
    const request = this.acceptFixed(value);
    return this.confirmAccepted(request);
  }

  /** Reusing an operation never repeats an append, advances revision or republishes the old fact. */
  applyFixed(value: TranscriptFixedAppend, provenance: TranscriptAppendOptions = {}): TranscriptAppendReceipt {
    this.enterMutation();
    try {
      const request = this.acceptFixed(value);
      const receipt = this.confirmAccepted(request);
      return receipt ?? this.appendAccepted(request.messages, provenance, request);
    } finally {
      this.#mutating = false;
    }
  }

  private appendAccepted(messages: readonly Readonly<Message>[], provenance: TranscriptAppendOptions, request?: TranscriptFixedAppend): TranscriptAppendReceipt {
    const start = this.length;
    const event = createTranscriptEvent(this.id, this.nextRevision(), { kind: 'messages-appended', start, messages }, provenance.origin);
    const receipt = Object.freeze({ transcriptId: this.id, start, count: messages.length, revision: event.revision });
    const fixed = request ? Object.freeze({ request, receipt }) : undefined;
    this.commit(Object.freeze({ kind: 'append', transcriptId: this.id, expectedRevision: this.#revision, revision: event.revision, start, messages, ...(fixed ? { fixed } : {}) }));
    for (const message of messages) this.#messages.push(message);
    this.#revision = event.revision;
    if (fixed) this.#appends.set(operationKey(fixed.request.operation), fixed);
    this.capture(event, provenance.observation, provenance.progress);
    return receipt;
  }

  private acceptFixed(value: unknown): TranscriptFixedAppend {
    if (!isObject(value) || !isObject(value.operation) || !isNonBlankString(value.operation.parentContextId) || !isNonBlankString(value.operation.childContextId) || !isNonBlankString(value.operation.position) || !isObject(value.contract) || !isArray(value.messages) || !value.messages.length) throw new TypeError('Invalid fixed transcript append request');
    if (value.transcriptId !== this.id || value.contract.key !== 'transcript.append' || value.contract.version !== 1) throw appendConflict();
    const operation = Object.freeze({ parentContextId: value.operation.parentContextId, childContextId: value.operation.childContextId, position: value.operation.position });
    const messages = Object.freeze(Array.from(value.messages, (message) => Transcript.accept(message)));
    return Object.freeze({ contract: Object.freeze({ key: 'transcript.append', version: 1 }), operation, transcriptId: this.id, messages });
  }

  private confirmAccepted(request: TranscriptFixedAppend): TranscriptAppendReceipt | undefined {
    const saved = this.#appends.get(operationKey(request.operation));
    if (!saved) return undefined;
    if (saved.request.messages.length !== request.messages.length || !this.matchesMessages(saved.receipt.start, request.messages)) throw appendConflict();
    return saved.receipt;
  }

  private matchesMessages(start: number, messages: readonly Readonly<Message>[]): boolean {
    return messages.every((message, offset) => this.#messages[start + offset]?.role === message.role && this.#messages[start + offset]?.content === message.content);
  }

  private capture(event: TranscriptEvent, observation = this.#observation, progress?: ProgressChannel<TranscriptAppendProgress>): void {
    if (event.change.kind === 'messages-appended') progress?.publish(Object.freeze({ transcriptId: this.id, start: event.change.start, end: event.change.start + event.change.messages.length, revision: event.revision }));
    publishFact(event, this.#changes, observation);
  }

  private enterMutation(): void {
    if (this.#mutating) throw new Error('Transcript persistence or change publication cannot reenter mutation');
    this.#mutating = true;
  }

  private nextRevision(): number {
    if (!isSafeInteger(this.#revision + 1)) throw new RangeError('Transcript revision is exhausted');
    return this.#revision + 1;
  }

  private commit(change: TranscriptCommit): void {
    const result: unknown = this.#persistence?.commit(change);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Transcript persistence must complete synchronously and return undefined');
    }
  }

  current(role: Message['role']): Readonly<Message> | undefined {
    const message = this.#messages.findLast((message) => message.role === role);
    return message;
  }

  get(index: number): Readonly<Message> | undefined {
    const message = this.#messages[index];
    return message;
  }

  ref(index: number): MessageRef {
    return new MessageRef(this, index);
  }

  snapshot(end = this.length): readonly Readonly<Message>[] {
    if (!isSafeInteger(end) || end < 0 || end > this.length) throw new RangeError('Transcript boundary does not exist');
    return this.#messages.slice(0, end);
  }

  private static accept(value: unknown): Readonly<Message> {
    if (!isObject(value)) throw new TypeError('消息必须是包含 role 和 content 的对象。');
    const message = value;
    if (message.role !== 'user' && message.role !== 'assistant') throw new TypeError('消息角色必须是 user 或 assistant。');
    if (!isNonBlankString(message.content)) throw new TypeError('消息内容必须是非空字符串。');
    return Object.freeze({ role: message.role, content: message.content });
  }
}

function operationKey(operation: TranscriptAppendOperation): string {
  return JSON.stringify([operation.parentContextId, operation.childContextId, operation.position]);
}

function appendConflict(): RuntimeError {
  return new RuntimeError('TRANSCRIPT_APPEND_CONFLICT', '固定消息追加的目标、契约或内容与原操作不一致。');
}
