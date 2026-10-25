import type { ChildCall, ChildCalls, ChildCallable, ChildOperationOptions, CallableDelta, CallableInput, CallableOutput } from '../definition/children.js';
import { collectDefinitionRequirements } from '../binding/resources.js';
import { resourceRequests } from '@capix/resources';
import type { OperationResult } from '@capix/resources/operation';
import type { ResourceRequest } from '@capix/resources';
import { isNonBlankString } from '../value/string.js';

export interface SequenceScope<Input, Outputs> {
  readonly input: Input;
  readonly outputs: Readonly<Outputs>;
}

/** A step uses the same result/delta operations as directly calling its member. */
export interface SequenceStep<Input, Outputs, Definition extends ChildCallable, Result = CallableOutput<Definition>> {
  readonly use: Definition;
  readonly input: (scope: SequenceScope<Input, Outputs>) => CallableInput<Definition>;
  readonly delta?: [CallableDelta<Definition>] extends [never] ? never : (delta: CallableDelta<Definition>, scope: SequenceScope<Input, Outputs>) => void;
  readonly result?: {
    readonly succeeded?: (value: CallableOutput<Definition>, scope: SequenceScope<Input, Outputs>) => Result | PromiseLike<Result>;
    readonly failed?: (failure: unknown, scope: SequenceScope<Input, Outputs>) => Result | PromiseLike<Result>;
  };
}

/** The concrete create signature checks the complete member grant; execution uses only invoke.
 * Keeping its generic signature preserves assignability of wider child collections. */
type SequenceChildren<Members extends ChildCallable> = Pick<ChildCalls<Members>, 'invoke' | 'create'> & {
  create: (definition: Members, input: CallableInput<Members>) => ChildCall<Members>;
};

interface Entry<Input, Members extends ChildCallable> {
  readonly key: string;
  readonly use: Members;
  run(input: Input, outputs: Readonly<Record<string, unknown>>, children: Pick<ChildCalls<Members>, 'invoke'>): Promise<unknown>;
}

/** Sequential composition is ordinary business control flow over registered child operations. */
export class Sequence<Input, Outputs = Record<never, never>, Members extends ChildCallable = never> {
  private readonly entries: readonly Entry<Input, Members>[];

  constructor(entries: readonly Entry<Input, Members>[] = []) {
    this.entries = Object.freeze([...entries]);
  }

  step<Key extends string, Definition extends ChildCallable, const Step extends SequenceStep<Input, Outputs, NoInfer<Definition>, unknown>>(key: Key extends keyof Outputs ? never : Key, definition: Step & SequenceStep<Input, Outputs, Definition, unknown>): Sequence<Input, Outputs & Record<Key, OperationResult<CallableOutput<Definition>, Step>>, Members | Definition> {
    if (!isNonBlankString(key) || this.entries.some((entry) => entry.key === key)) throw new Error('Sequence work keys must be non-blank and unique');
    const use = definition.use;
    const prepare = definition.input.bind(definition);
    const delta = definition.delta?.bind(definition);
    const succeeded = definition.result?.succeeded?.bind(definition.result);
    const failed = definition.result?.failed?.bind(definition.result);
    const entry: Entry<Input, Members | Definition> = Object.freeze({
      key,
      use,
      async run(input: Input, outputs: Readonly<Record<string, unknown>>, children: Pick<ChildCalls<Members | Definition>, 'invoke'>) {
        const scope = Object.freeze({ input, outputs: outputs as Readonly<Outputs> });
        return children.invoke(use, prepare(scope), {
          key,
          // The public step has already checked whether this member declares Delta.
          ...(delta ? { delta: ((value: CallableDelta<Definition>) => delta(value, scope)) as ChildOperationOptions<Definition>['delta'] } : {}),
          result: {
            ...(succeeded ? { succeeded: (value: CallableOutput<Definition>) => succeeded(value, scope) } : {}),
            ...(failed ? { failed: (failure: unknown) => failed(failure, scope) } : {}),
          },
        });
      },
    });
    return new Sequence([...this.entries, entry]);
  }

  get steps() {
    return Object.freeze(this.entries.map(({ key, use }) => Object.freeze({ key, use })));
  }

  get requests(): readonly ResourceRequest<unknown>[] {
    return Object.freeze(this.entries.flatMap(({ use }) => resourceRequests(collectDefinitionRequirements({ deps: use.deps ?? {}, checkpoint: use.checkpoint }))));
  }

  async run(input: Input, children: SequenceChildren<Members>): Promise<Readonly<Outputs>> {
    let outputs: Readonly<Record<string, unknown>> = Object.freeze({});
    for (const entry of this.entries) {
      const output = await entry.run(input, outputs, children);
      outputs = Object.freeze({ ...outputs, [entry.key]: output });
    }
    return outputs as Readonly<Outputs>;
  }
}
