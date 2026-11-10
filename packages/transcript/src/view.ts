import { RuntimeError } from '@weiliang0121/capix-contracts';
import type { Message } from '@weiliang0121/capix-protocol';
import type { SyncViewSource } from '@weiliang0121/capix-view';
import type { Transcript } from './transcript.js';

export interface TranscriptViewSummary {
  readonly role: Message['role'];
}

type TranscriptViewContract = SyncViewSource<number, TranscriptViewSummary, Readonly<Message>>;
type SourceStamp = Parameters<TranscriptViewContract['read']>[1];

/** A complete directory of one transcript, or of an explicitly fixed ordered subset. */
export class TranscriptViewSource implements TranscriptViewContract {
  readonly id: string;
  readonly scope: string;
  readonly #transcript: Transcript;
  readonly #keys?: readonly number[];
  readonly #allowed?: ReadonlySet<number>;

  constructor(transcript: Transcript, keys?: readonly number[]) {
    this.#transcript = transcript;
    this.id = transcript.id;
    if (keys !== undefined) {
      this.#keys = this.acceptKeys(keys);
      for (const key of this.#keys) this.requireMessage(key);
      this.#allowed = new Set(this.#keys);
    }
    this.scope = this.#keys === undefined ? 'whole' : `keys:${JSON.stringify(this.#keys)}`;
    Object.freeze(this);
  }

  index(): ReturnType<TranscriptViewContract['index']> {
    const stamp = this.stamp();
    const keys = this.#keys ?? Array.from({ length: this.#transcript.length }, (_, index) => index);
    const entries = Object.freeze(keys.map((key) => Object.freeze({ key, summary: Object.freeze({ role: this.requireMessage(key).role }) })));
    this.requireCurrent(stamp);
    return Object.freeze({ stamp, entries });
  }

  inspect(keys: readonly number[]): ReturnType<TranscriptViewContract['inspect']> {
    const stamp = this.stamp();
    const selected = this.acceptKeys(keys);
    const entries = Object.freeze(
      selected.map((key) => {
        if (this.#allowed && !this.#allowed.has(key)) throw new RangeError('Message is outside the view source scope');
        return Object.freeze({ key, summary: Object.freeze({ role: this.requireMessage(key).role }) });
      }),
    );
    this.requireCurrent(stamp);
    return Object.freeze({ stamp, entries });
  }

  read(keys: readonly number[], expected: SourceStamp): ReturnType<TranscriptViewContract['read']> {
    const basis = Object.freeze({ id: expected.id, scope: expected.scope, version: expected.version });
    this.requireCurrent(basis);
    const selected = this.acceptKeys(keys);
    const entries = Object.freeze(
      selected.map((key) => {
        if (this.#allowed && !this.#allowed.has(key)) throw new RangeError('Message is outside the view source scope');
        return Object.freeze({ key, value: this.requireMessage(key) });
      }),
    );
    this.requireCurrent(basis);
    return Object.freeze({ stamp: this.stamp(), entries });
  }

  check(expected: SourceStamp): boolean {
    return expected?.id === this.id && expected.scope === this.scope && expected.version === String(this.#transcript.revision);
  }

  private stamp(): SourceStamp {
    return Object.freeze({ id: this.id, scope: this.scope, version: String(this.#transcript.revision) });
  }

  private requireCurrent(expected: SourceStamp): void {
    if (!this.check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Transcript view source has changed');
  }

  private acceptKeys(keys: readonly number[]): readonly number[] {
    if (!Array.isArray(keys)) throw new TypeError('Transcript view keys must be an array');
    const accepted = Array.from(keys);
    if (accepted.some((key) => !Number.isSafeInteger(key) || key < 0) || new Set(accepted).size !== accepted.length) throw new TypeError('Transcript view requires unique nonnegative integer keys');
    return Object.freeze(accepted);
  }

  private requireMessage(key: number): Readonly<Message> {
    const message = this.#transcript.get(key);
    if (!message) throw new RangeError('Transcript view message does not exist');
    return message;
  }
}
