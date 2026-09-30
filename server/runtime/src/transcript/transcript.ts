import { TranscriptRecordHelper } from '../records/transcript/helper.js';
import { writeRecord } from '../records/error.js';
import { randomUUID } from 'node:crypto';
import type { Recorder } from '../records/recorder.js';
import type { ChangeSource } from '../records/source.js';
import { isArray, isSafeInteger } from 'es-toolkit/compat';
import { isNonBlankString } from '../value/string.js';
import { isObject } from '../value/object.js';
import { MessageRef, TranscriptRangeRef } from './ref.js';
import type { Message } from '@capix-observer/protocol';

/** Original accepted messages, including the current input; independent of execution records. */
export class Transcript {
  readonly id = randomUUID();
  readonly #recorder?: Recorder;
  readonly #messages: Readonly<Message>[] = [];
  readonly #starts: number[] = [0];

  constructor(messages: readonly Message[] = [], recorder?: Recorder) {
    this.#recorder = recorder;
    if (!isArray(messages)) throw new TypeError('消息集合必须是数组。');
    this.append(...messages);
  }

  get length(): number {
    return this.#messages.length;
  }

  get activeStart(): number {
    return this.#starts.at(-1)!;
  }

  /** Segment boundaries share immutable messages and preserve absolute indexes. */
  segments(): readonly TranscriptRangeRef[] {
    return this.#starts.map((start, index) => new TranscriptRangeRef(this, start, this.#starts[index + 1] ?? this.length));
  }

  startSegment(start: number, source?: ChangeSource): void {
    if (!isSafeInteger(start) || start <= this.activeStart || start >= this.length) throw new RangeError('New segment must start inside the active range');
    const previousStart = this.activeStart;
    this.#starts.push(start);
    const recorder = this.#recorder;
    if (recorder) writeRecord(() => recorder.add(TranscriptRecordHelper.create(this.id, { action: 'segment', previousStart, start, end: this.length }, recorder.clock, source)));
  }

  append(...messages: readonly Message[]): void {
    this.appendFrom(messages);
  }

  appendFrom(messages: readonly Message[], source?: ChangeSource): void {
    if (!isArray(messages)) throw new TypeError('消息集合必须是数组。');
    // Check the whole batch before changing the transcript.
    const accepted = messages.map((message) => Transcript.accept(message));
    const start = this.length;
    for (const message of accepted) this.#messages.push(message);
    const recorder = this.#recorder;
    if (accepted.length && recorder) writeRecord(() => recorder.add(TranscriptRecordHelper.create(this.id, { action: 'append', start, messages: accepted }, recorder.clock, source)));
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
