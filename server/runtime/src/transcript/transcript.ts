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

export interface TranscriptOptions {
  observation?: EventConsumer<TranscriptEvent>;
  changes?: ChangeCapture<TranscriptEvent>;
}

export interface TranscriptAppendOptions extends ChangeProvenance<TranscriptEvent> {
  readonly progress?: ProgressChannel<TranscriptAppendProgress>;
}

/** Original accepted messages, including the current input; independent of execution records. */
export class Transcript {
  readonly id = randomUUID();
  readonly #observation?: EventConsumer<TranscriptEvent>;
  #publishing = false;
  readonly #changes?: ChangeCapture<TranscriptEvent>;
  #revision = 0;
  readonly #messages: Readonly<Message>[] = [];
  readonly #starts: number[] = [0];

  constructor(messages: readonly Message[] = [], options: TranscriptOptions = {}) {
    this.#observation = options.observation;
    this.#changes = options.changes;
    if (!isArray(messages)) throw new TypeError('消息集合必须是数组。');
    this.append(...messages);
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
    if (this.#publishing) throw new Error('Transcript change publication cannot reenter mutation');
    if (!isSafeInteger(start) || start <= this.activeStart || start >= this.length) throw new RangeError('New segment must start inside the active range');
    const previousStart = this.activeStart;
    const end = this.length;
    const event = createTranscriptEvent(this.id, this.#revision + 1, { kind: 'segment-started', previousStart, start, end }, provenance.origin);
    this.#starts.push(start);
    this.#revision = event.revision;
    this.capture(event, provenance.observation);
  }

  append(...messages: readonly Message[]): void {
    this.appendFrom(messages);
  }

  appendFrom(messages: readonly Message[], provenance: TranscriptAppendOptions = {}): void {
    if (this.#publishing) throw new Error('Transcript change publication cannot reenter mutation');
    if (!isArray(messages)) throw new TypeError('消息集合必须是数组。');
    // Check the whole batch before changing the transcript.
    const accepted = messages.map((message) => Transcript.accept(message));
    if (!accepted.length) return;
    const start = this.length;
    const event = createTranscriptEvent(this.id, this.#revision + 1, { kind: 'messages-appended', start, messages: accepted }, provenance.origin);
    for (const message of accepted) this.#messages.push(message);
    this.#revision = event.revision;
    this.capture(event, provenance.observation, provenance.progress);
  }

  private capture(event: TranscriptEvent, observation = this.#observation, progress?: ProgressChannel<TranscriptAppendProgress>): void {
    this.#publishing = true;
    try {
      if (event.change.kind === 'messages-appended') progress?.publish(Object.freeze({ transcriptId: this.id, start: event.change.start, end: event.change.start + event.change.messages.length, revision: event.revision }));
      publishFact(event, this.#changes, observation);
    } finally {
      this.#publishing = false;
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
