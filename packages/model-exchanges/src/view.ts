import { RuntimeError } from '@weiliang0121/capix-contracts';
import type { SourceStamp, SyncViewSource } from '@weiliang0121/capix-view';
import type { ModelExchanges } from './exchanges.js';
import type { ModelExchangeEntry } from './types.js';
import { capture, identity, record } from './value.js';

export interface ModelExchangeSummary {
  readonly model: string;
  readonly replyId: string;
  readonly toolCalls: number;
  readonly completed: number;
}

type Source = SyncViewSource<string, ModelExchangeSummary, ModelExchangeEntry>;

/** An exchange is one view member. Selection never leaves orphaned tool messages. */
export class ModelExchangeViewSource implements Source {
  readonly id: string;
  readonly scope: string;
  readonly #exchanges: ModelExchanges;
  readonly #group?: string;

  constructor(exchanges: ModelExchanges, scope?: string) {
    this.#exchanges = exchanges;
    this.#group = scope === undefined ? undefined : identity(scope);
    this.id = exchanges.id;
    this.scope = scope === undefined ? 'whole' : `scope:${JSON.stringify(scope)}`;
    Object.freeze(this);
  }

  index(): ReturnType<Source['index']> {
    const stamp = this.stamp();
    const entries = Object.freeze(this.#exchanges.values(this.#group).map((entry) => Object.freeze({ key: entry.id, summary: summarize(entry) })));
    this.requireCurrent(stamp);
    return Object.freeze({ stamp, entries });
  }

  inspect(keys: readonly string[]): ReturnType<Source['inspect']> {
    const stamp = this.stamp();
    const entries = Object.freeze(this.select(keys).map((entry) => Object.freeze({ key: entry.id, summary: summarize(entry) })));
    this.requireCurrent(stamp);
    return Object.freeze({ stamp, entries });
  }

  read(keys: readonly string[], expected: SourceStamp): ReturnType<Source['read']> {
    const value = record(capture(expected), ['id', 'scope', 'version']);
    if (typeof value.id !== 'string' || typeof value.scope !== 'string' || typeof value.version !== 'string') throw new TypeError('Invalid model exchange source stamp');
    const basis = Object.freeze({ id: value.id, scope: value.scope, version: value.version });
    this.requireCurrent(basis);
    const entries = Object.freeze(this.select(keys).map((entry) => Object.freeze({ key: entry.id, value: entry })));
    this.requireCurrent(basis);
    return Object.freeze({ stamp: this.stamp(), entries });
  }

  check(expected: SourceStamp): boolean {
    return expected?.id === this.id && expected.scope === this.scope && expected.version === String(this.#exchanges.sequence);
  }

  private stamp(): SourceStamp {
    return Object.freeze({ id: this.id, scope: this.scope, version: String(this.#exchanges.sequence) });
  }
  private requireCurrent(expected: SourceStamp): void {
    if (!this.check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Model exchange view source has changed');
  }
  private select(keys: readonly string[]): readonly ModelExchangeEntry[] {
    const selected = capture(keys);
    if (!Array.isArray(selected) || selected.some((key) => typeof key !== 'string' || !key) || new Set(selected).size !== selected.length) throw new TypeError('Model exchange view requires unique string keys');
    return selected.map((key) => {
      const entry = this.#exchanges.get(identity(key));
      if (!entry || (this.#group !== undefined && entry.scope !== this.#group)) throw new RangeError('Exchange is outside the view source scope');
      return entry;
    });
  }
}

function summarize(entry: ModelExchangeEntry): ModelExchangeSummary {
  return Object.freeze({ model: entry.reply.model, replyId: entry.reply.id, toolCalls: entry.reply.output.filter((item) => item.kind === 'tool-call').length, completed: entry.feedback.length });
}
