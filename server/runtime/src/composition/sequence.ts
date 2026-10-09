import { definitionResources } from '../definition/invocation.js';
import type { DeclaredCall } from '../definition/signature.js';
import { InvocationEntry } from '../definition/entry.js';
import type { ChildDefinition } from '../definition/children.js';
import type { ChildBindings } from '../binding/children.js';
import { resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRequest } from '../resource/offer.js';
import type { ParentInvocation } from '../invocation/children.js';
import type { InvocationView, ChildCall } from '../invocation/view.js';
import type { InvocationRelationOptions, InvocationTarget } from '../invocation/relation.js';
import { isNonBlankString } from '../value/string.js';

export interface SequenceScope<S, P, R> {
  readonly parent: P;
  readonly input: S;
  readonly outputs: Readonly<R>;
}

export interface SequenceStep<S, P, R, I, O, A = O> {
  readonly use: DeclaredCall<P, I, O> | { readonly requires?: ResourceRequirements; create(parent: P, input: I, options?: InvocationRelationOptions): InvocationTarget<O> | ChildCall<any, O, any> };
  readonly input: (scope: SequenceScope<S, P, R>) => I;
  /** Parent-owned work after successful delivery; its result is available to later steps. */
  readonly accept?: (scope: SequenceScope<S, P, R>, output: O) => A | Promise<A>;
}

type Entry<S, P> = Readonly<{ key: string; use: { readonly requires?: ResourceRequirements; readonly run?: { readonly requires: ResourceRequirements }; readonly exceptions?: { readonly requires: ResourceRequirements } }; run(parent: P, input: S, outputs: Readonly<Record<string, unknown>>, children?: ChildBindings): Promise<unknown> }>;

/** An immutable, typed sequential composition. No scheduling, retry or recovery policy. */
export class Sequence<S, P extends ParentInvocation | InvocationView, R = Record<never, never>> {
  private readonly entries: readonly Entry<S, P>[];

  constructor(entries: readonly Entry<S, P>[] = []) {
    this.entries = Object.freeze([...entries]);
  }

  step<K extends string, I, O, A = O>(key: K extends keyof R ? never : K, definition: SequenceStep<S, P, R, I, O, A>): Sequence<S, P, R & Record<K, A>> {
    if (!isNonBlankString(key) || this.entries.some((entry) => entry.key === key)) throw new Error('Sequence work keys must be non-blank and unique');
    const { use, input: prepare, accept } = definition;
    const entry: Entry<S, P> = Object.freeze({
      key,
      use,
      async run(parent: P, input: S, outputs: Readonly<Record<string, unknown>>, children?: ChildBindings) {
        const scope = Object.freeze({ parent, input, outputs: outputs as Readonly<R> });
        const target = 'create' in use ? use : resolveDeclared(use, children);
        const child = target.create(parent, prepare(scope), { key });

        const output = await child.run();
        if (children) {
          children.requireActive();
          return children.accept(child as ChildCall, () => (accept ? accept(scope, output) : output));
        }
        const owner = parent as ParentInvocation;
        owner.context.requireRunning();
        return owner.children.get(child as InvocationTarget).accept(() => (accept ? accept(scope, output) : output));
      },
    });
    return new Sequence([...this.entries, entry]);
  }

  /** Read the same definitions that execute; no second dependency graph. */
  get steps() {
    return Object.freeze(this.entries.map(({ key, use }) => Object.freeze({ key, use })));
  }

  get requests(): readonly ResourceRequest<unknown>[] {
    return Object.freeze(this.entries.flatMap(({ use }) => resourceRequests(use.run ? definitionResources({ run: use.run, exceptions: use.exceptions }) : (use.requires ?? {}))));
  }

  async run(parent: P, input: S, children?: ChildBindings): Promise<Readonly<R>> {
    let outputs: Readonly<Record<string, unknown>> = Object.freeze({});
    for (const entry of this.entries) {
      if (children) children.requireActive();
      else (parent as ParentInvocation).context.requireRunning();
      const output = await entry.run(parent, input, outputs, children);
      outputs = Object.freeze({ ...outputs, [entry.key]: output });
    }
    return outputs as Readonly<R>;
  }
}

/** Resolution is confined to the binding supplied for this parent invocation. */
function resolveDeclared<P, I, O>(use: DeclaredCall<P, I, O>, children?: ChildBindings): { create(parent: P, input: I, options?: InvocationRelationOptions): InvocationTarget<O> | ChildCall<any, O, any> } {
  if (!children) throw new Error('Declared sequence requires its child binding');
  const target = use instanceof InvocationEntry ? children.entry(use) : children.get(use as unknown as ChildDefinition);
  return target as unknown as { create(parent: P, input: I, options?: InvocationRelationOptions): InvocationTarget<O> | ChildCall<any, O, any> };
}
