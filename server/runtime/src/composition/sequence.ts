import type { InvocationOutputReceiver } from '../output/contract.js';
import { definitionResources } from '../binding/resources.js';
import type { DeclaredCall } from '../definition/signature.js';
import { InvocationEntry } from '../definition/entry.js';
import type { ChildDefinition } from '../definition/children.js';
import type { ChildBindings } from '../binding/children/contract.js';
import { resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRequest } from '../resource/offer.js';
import type { ParentInvocation } from '../invocation/children.js';
import type { InvocationView, ChildInvocationView } from '../invocation/view.js';
import type { InvocationRelationOptions, InvocationTarget } from '../invocation/relation.js';
import { isNonBlankString } from '../value/string.js';

export interface SequenceScope<Input, Parent, Outputs> {
  readonly parent: Parent;
  readonly input: Input;
  readonly outputs: Readonly<Outputs>;
}

export interface SequenceStep<Input, Parent, Outputs, StepInput, StepOutput, AcceptedOutput = StepOutput> {
  readonly use: DeclaredCall<Parent, StepInput, StepOutput> | { readonly requires?: ResourceRequirements; create(parent: Parent, input: StepInput, options?: InvocationRelationOptions): InvocationTarget<StepOutput> | ChildInvocationView<any, StepOutput, any> };
  /** Explicit passive consumption; sequence ordering still depends only on final child delivery. */
  readonly output?: (scope: SequenceScope<Input, Parent, Outputs>) => InvocationOutputReceiver<StepOutput, any> | undefined;
  readonly input: (scope: SequenceScope<Input, Parent, Outputs>) => StepInput;
  /** Parent-owned work after successful delivery; its result is available to later steps. */
  readonly accept?: (scope: SequenceScope<Input, Parent, Outputs>, output: StepOutput) => AcceptedOutput | Promise<AcceptedOutput>;
}

type Entry<Input, Parent> = Readonly<{ key: string; use: { readonly requires?: ResourceRequirements; readonly run?: { readonly requires: ResourceRequirements }; readonly exceptions?: { readonly requires: ResourceRequirements } }; run(parent: Parent, input: Input, outputs: Readonly<Record<string, unknown>>, children?: ChildBindings): Promise<unknown> }>;

/** An immutable, typed sequential composition. No scheduling, retry or recovery policy. */
export class Sequence<Input, Parent extends ParentInvocation | InvocationView, Outputs = Record<never, never>> {
  private readonly entries: readonly Entry<Input, Parent>[];

  constructor(entries: readonly Entry<Input, Parent>[] = []) {
    this.entries = Object.freeze([...entries]);
  }

  step<Key extends string, StepInput, StepOutput, AcceptedOutput = StepOutput>(key: Key extends keyof Outputs ? never : Key, definition: SequenceStep<Input, Parent, Outputs, StepInput, StepOutput, AcceptedOutput>): Sequence<Input, Parent, Outputs & Record<Key, AcceptedOutput>> {
    if (!isNonBlankString(key) || this.entries.some((entry) => entry.key === key)) throw new Error('Sequence work keys must be non-blank and unique');
    const { use, input: prepare, accept, output } = definition;
    const entry: Entry<Input, Parent> = Object.freeze({
      key,
      use,
      async run(parent: Parent, input: Input, outputs: Readonly<Record<string, unknown>>, children?: ChildBindings) {
        const scope = Object.freeze({ parent, input, outputs: outputs as Readonly<Outputs> });
        const target = 'create' in use ? use : resolveDeclared(use, children);
        const child = target.create(parent, prepare(scope), { key, output: output?.(scope) });

        await child.run();
        if (children) {
          children.requireActive();
          return children.accept(child as ChildInvocationView<unknown, StepOutput>, (delivered) => (accept ? accept(scope, delivered) : delivered));
        }
        const owner = parent as ParentInvocation;
        owner.context.requireRunning();
        return owner.children.get(child as InvocationTarget<StepOutput>).accept((delivered) => (accept ? accept(scope, delivered) : delivered));
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

  async run(parent: Parent, input: Input, children?: ChildBindings): Promise<Readonly<Outputs>> {
    let outputs: Readonly<Record<string, unknown>> = Object.freeze({});
    for (const entry of this.entries) {
      if (children) children.requireActive();
      else (parent as ParentInvocation).context.requireRunning();
      const output = await entry.run(parent, input, outputs, children);
      outputs = Object.freeze({ ...outputs, [entry.key]: output });
    }
    return outputs as Readonly<Outputs>;
  }
}

/** Resolution is confined to the binding supplied for this parent invocation. */
function resolveDeclared<Parent, StepInput, StepOutput>(use: DeclaredCall<Parent, StepInput, StepOutput>, children?: ChildBindings): { create(parent: Parent, input: StepInput, options?: InvocationRelationOptions): InvocationTarget<StepOutput> | ChildInvocationView<any, StepOutput, any> } {
  if (!children) throw new Error('Declared sequence requires its child binding');
  const target = use instanceof InvocationEntry ? children.entry(use) : children.get(use as unknown as ChildDefinition);
  return target as unknown as { create(parent: Parent, input: StepInput, options?: InvocationRelationOptions): InvocationTarget<StepOutput> | ChildInvocationView<any, StepOutput, any> };
}
