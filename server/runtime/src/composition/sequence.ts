import type { ParentInvocation } from '../invocation/children.js';
import type { InvocationRelationOptions, InvocationTarget } from '../invocation/relation.js';
import { isNonBlankString } from '../value/string.js';

export interface SequenceScope<S, P, R> {
  readonly parent: P;
  readonly input: S;
  readonly outputs: Readonly<R>;
}

export interface SequenceStep<S, P, R, I, O, A = O> {
  readonly use: { create(parent: P, input: I, options?: InvocationRelationOptions): InvocationTarget<O> };
  readonly input: (scope: SequenceScope<S, P, R>) => I;
  /** Parent-owned work after successful delivery; its result is available to later steps. */
  readonly accept?: (scope: SequenceScope<S, P, R>, output: O) => A | Promise<A>;
}

type Entry<S, P> = Readonly<{ key: string; run(parent: P, input: S, outputs: Readonly<Record<string, unknown>>): Promise<unknown> }>;

/** An immutable, typed sequential composition. No scheduling, retry or recovery policy. */
export class Sequence<S, P extends ParentInvocation, R = Record<never, never>> {
  private readonly entries: readonly Entry<S, P>[];

  constructor(entries: readonly Entry<S, P>[] = []) {
    this.entries = Object.freeze([...entries]);
  }

  step<K extends string, I, O, A = O>(key: K extends keyof R ? never : K, definition: SequenceStep<S, P, R, I, O, A>): Sequence<S, P, R & Record<K, A>> {
    if (!isNonBlankString(key) || this.entries.some((entry) => entry.key === key)) throw new Error('Sequence work keys must be non-blank and unique');
    const { use, input: prepare, accept } = definition;
    const entry: Entry<S, P> = Object.freeze({
      key,
      async run(parent: P, input: S, outputs: Readonly<Record<string, unknown>>) {
        const scope = Object.freeze({ parent, input, outputs: outputs as Readonly<R> });
        const child = use.create(parent, prepare(scope), { key });
        const relation = parent.children.get(child);
        const output = await child.run();
        parent.context.requireRunning();
        return relation.accept(() => (accept ? accept(scope, output) : output));
      },
    });
    return new Sequence([...this.entries, entry]);
  }

  async run(parent: P, input: S): Promise<Readonly<R>> {
    let outputs: Readonly<Record<string, unknown>> = Object.freeze({});
    for (const entry of this.entries) {
      parent.context.requireRunning();
      const output = await entry.run(parent, input, outputs);
      outputs = Object.freeze({ ...outputs, [entry.key]: output });
    }
    return outputs as Readonly<R>;
  }
}
