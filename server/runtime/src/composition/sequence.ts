import type { InvocationOutputReceiver } from '../output/contract.js';
import { collectDefinitionRequirements } from '../binding/resources.js';
import { InvocationEntry } from '../definition/entry.js';
import type { ChildCalls, ChildDefinition, DefinitionDelta, DefinitionInput, DefinitionOutput } from '../definition/children.js';
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

interface Entry<Input> {
  readonly key: string;
  readonly use: ChildDefinition | InvocationEntry<ChildDefinition, never>;
  run(input: Input, outputs: Readonly<Record<string, unknown>>, children: ChildCalls): Promise<unknown>;
}

/** A convenience over the same create → run → accept contract available to any parent. */
export class Sequence<Input, Outputs = Record<never, never>> {
  private readonly entries: readonly Entry<Input>[];

  constructor(entries: readonly Entry<Input>[] = []) {
    this.entries = Object.freeze([...entries]);
  }

  step<Key extends string, Definition extends ChildDefinition, AcceptedOutput = DefinitionOutput<Definition>>(key: Key extends keyof Outputs ? never : Key, definition: SequenceStep<Input, Outputs, Definition, NoInfer<DefinitionInput<Definition>>, AcceptedOutput> & { readonly use: Definition }): Sequence<Input, Outputs & Record<Key, AcceptedOutput>>;
  step<Key extends string, Definition extends ChildDefinition, StepInput, AcceptedOutput = DefinitionOutput<Definition>>(key: Key extends keyof Outputs ? never : Key, definition: SequenceStep<Input, Outputs, Definition, StepInput, AcceptedOutput> & { readonly use: InvocationEntry<Definition, StepInput> }): Sequence<Input, Outputs & Record<Key, AcceptedOutput>>;
  step<Key extends string, Definition extends ChildDefinition, StepInput, AcceptedOutput>(key: Key extends keyof Outputs ? never : Key, definition: SequenceStep<Input, Outputs, Definition, StepInput, AcceptedOutput>): Sequence<Input, Outputs & Record<Key, AcceptedOutput>> {
    if (!isNonBlankString(key) || this.entries.some((entry) => entry.key === key)) throw new Error('Sequence work keys must be non-blank and unique');
    const { use, input: prepare, accept, output } = definition;
    const entry: Entry<Input> = Object.freeze({
      key,
      use,
      async run(input: Input, outputs: Readonly<Record<string, unknown>>, children: ChildCalls) {
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

  async run(input: Input, children: ChildCalls): Promise<Readonly<Outputs>> {
    let outputs: Readonly<Record<string, unknown>> = Object.freeze({});
    for (const entry of this.entries) {
      const output = await entry.run(input, outputs, children);
      outputs = Object.freeze({ ...outputs, [entry.key]: output });
    }
    return outputs as Readonly<Outputs>;
  }
}
