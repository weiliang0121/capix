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
    return transcript;
  }

  exportState(): TranscriptState {
    return Object.freeze({ id: this.id, revision: this.#revision, starts: Object.freeze([...this.#starts]), messages: Object.freeze([...this.#messages]) });
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
      const start = this.length;
      const event = createTranscriptEvent(this.id, this.nextRevision(), { kind: 'messages-appended', start, messages: accepted }, provenance.origin);
      this.commit(Object.freeze({ kind: 'append', transcriptId: this.id, expectedRevision: this.#revision, revision: event.revision, start, messages: accepted }));
      for (const message of accepted) this.#messages.push(message);
      this.#revision = event.revision;
      this.capture(event, provenance.observation, provenance.progress);
    } finally {
      this.#mutating = false;
    }
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
