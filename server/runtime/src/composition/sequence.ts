import type { InvocationOutputReceiver } from '../output/contract.js';
import { collectDefinitionRequirements } from '../binding/resources.js';
import { InvocationEntry } from '../definition/entry.js';
import type { ChildCall, ChildCalls, ChildDefinition, ChildOptions, DefinitionDelta, DefinitionInput, DefinitionOutput } from '../definition/children.js';
import { resourceRequests } from '../resource/bindings.js';
import type { ResourceRequest } from '../resource/offer.js';
import { isNonBlankString } from '../value/string.js';

export interface SequenceScope<Input, Outputs> {
  readonly input: Input;
  readonly outputs: Readonly<Outputs>;
}

export interface SequenceStep<Input, Outputs, Definition extends ChildDefinition, StepInput = DefinitionInput<Definition>, AcceptedOutput = DefinitionOutput<Definition>> {
  readonly use: Definition | InvocationEntry<Definition, StepInput>;
  readonly input: (scope: SequenceScope<Input, Outputs>) => StepInput;
  /** Passive output is separate from final delivery and explicit parent reception. */
  readonly output?: (scope: SequenceScope<Input, Outputs>) => InvocationOutputReceiver<DefinitionOutput<Definition>, DefinitionDelta<Definition>> | undefined;
  readonly accept?: (scope: SequenceScope<Input, Outputs>, output: DefinitionOutput<Definition>) => AcceptedOutput | Promise<AcceptedOutput>;
}

type SequenceCalls<Uses extends ChildDefinition> = Pick<ChildCalls<Uses>, 'create' | 'entry'> & {
  /** A concrete grant check; generic create alone can erase a narrower phase allowance. */
  readonly create: (definition: Uses, input: DefinitionInput<Uses>, options?: ChildOptions<Uses>) => ChildCall<Uses>;
};

interface Entry<Input, Uses extends ChildDefinition> {
  readonly key: string;
  readonly use: Uses | InvocationEntry<Uses, never>;
  run(input: Input, outputs: Readonly<Record<string, unknown>>, children: Pick<ChildCalls<Uses>, 'create' | 'entry'>): Promise<unknown>;
}

/** A convenience over the same create → run → accept contract available to any parent. */
export class Sequence<Input, Outputs = Record<never, never>, Uses extends ChildDefinition = never> {
  private readonly entries: readonly Entry<Input, Uses>[];

  constructor(entries: readonly Entry<Input, Uses>[] = []) {
    this.entries = Object.freeze([...entries]);
  }

  step<Key extends string, Definition extends ChildDefinition, AcceptedOutput = DefinitionOutput<Definition>>(key: Key extends keyof Outputs ? never : Key, definition: SequenceStep<Input, Outputs, Definition, NoInfer<DefinitionInput<Definition>>, AcceptedOutput> & { readonly use: Definition }): Sequence<Input, Outputs & Record<Key, AcceptedOutput>, Uses | Definition>;
  step<Key extends string, Definition extends ChildDefinition, StepInput, AcceptedOutput = DefinitionOutput<Definition>>(key: Key extends keyof Outputs ? never : Key, definition: SequenceStep<Input, Outputs, Definition, StepInput, AcceptedOutput> & { readonly use: InvocationEntry<Definition, StepInput> }): Sequence<Input, Outputs & Record<Key, AcceptedOutput>, Uses | Definition>;
  step<Key extends string, Definition extends ChildDefinition, StepInput, AcceptedOutput>(key: Key extends keyof Outputs ? never : Key, definition: SequenceStep<Input, Outputs, Definition, StepInput, AcceptedOutput>): Sequence<Input, Outputs & Record<Key, AcceptedOutput>, Uses | Definition> {
    if (!isNonBlankString(key) || this.entries.some((entry) => entry.key === key)) throw new Error('Sequence work keys must be non-blank and unique');
    const { use, input: prepare, accept, output } = definition;
    const entry: Entry<Input, Uses | Definition> = Object.freeze({
      key,
      use,
      async run(input: Input, outputs: Readonly<Record<string, unknown>>, children: Pick<ChildCalls<Uses | Definition>, 'create' | 'entry'>) {
        const scope = Object.freeze({ input, outputs: outputs as Readonly<Outputs> });
        const options = { key, output: output?.(scope) };
        const child = use instanceof InvocationEntry ? children.entry(use, prepare(scope), options) : children.create(use, prepare(scope) as DefinitionInput<Definition>, options);
        await child.run();
        return accept ? child.accept((delivered) => accept(scope, delivered)) : child.accept();
      },
    });
    return new Sequence([...this.entries, entry]);
  }

  get steps() {
    return Object.freeze(this.entries.map(({ key, use }) => Object.freeze({ key, use })));
  }

  get requests(): readonly ResourceRequest<unknown>[] {
    return Object.freeze(this.entries.flatMap(({ use }) => resourceRequests(collectDefinitionRequirements({ run: use.run, exceptions: use.exceptions }))));
  }

  async run(input: Input, children: SequenceCalls<Uses>): Promise<Readonly<Outputs>> {
    let outputs: Readonly<Record<string, unknown>> = Object.freeze({});
    for (const entry of this.entries) {
      const output = await entry.run(input, outputs, children);
      outputs = Object.freeze({ ...outputs, [entry.key]: output });
    }
    return outputs as Readonly<Outputs>;
  }
}
