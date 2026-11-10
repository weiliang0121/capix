import { types } from 'node:util';
import { Callable } from '../callable.js';
import { Group } from '../group.js';
import { requireChildCallable } from '../members.js';
import type { ChildCallable } from '../definition/children.js';
import type { MemberInput } from './input.js';
import type { Stable, ChildCalls, CallableDelta, CallableOutput, InvocationOutputWriter, OperationResult, OutputDeclaration } from '@weiliang0121/capix-contracts';

export type SequenceScope<Input, Previous, Delta = never> = { readonly input: Stable<Input>; readonly previous: Stable<Previous> } & ([Delta] extends [never] ? object : { readonly output: InvocationOutputWriter<Delta> });

/** Use satisfies to contextually type a configured step without losing its exact callback results. */
export interface SequenceStep<Member extends ChildCallable, Input = MemberInput<Member>, Previous = Input, Delta = never> {
  readonly node: Member;
  readonly key?: string;
  readonly input?: (scope: SequenceScope<Input, Previous, Delta>) => MemberInput<Member> | Stable<MemberInput<Member>>;
  readonly delta?: [CallableDelta<Member>] extends [never] ? never : (delta: Stable<CallableDelta<Member>>, scope: SequenceScope<Input, Previous, Delta>) => void;
  readonly result?: {
    readonly succeeded?: (value: Stable<CallableOutput<Member>>, scope: SequenceScope<Input, Previous, Delta>) => unknown;
    readonly failed?: (failure: unknown, scope: SequenceScope<Input, Previous, Delta>) => unknown;
  };
}

// Inference first captures the actual tuple. Validation then checks every connection;
// it does not contextually widen callback arguments or results to any.
export type SequenceItem = ChildCallable | { readonly node: ChildCallable };
type StepNode<Step> = Step extends ChildCallable ? Step : Step extends { readonly node: infer Member extends ChildCallable } ? Member : never;
type Accepted<Step> = Stable<OperationResult<Stable<CallableOutput<StepNode<Step>>>, Step>>;
type Initial<Step> = Step extends { readonly input: (scope: infer Scope) => unknown } ? (Scope extends { readonly input: infer Input } ? Input : unknown) : MemberInput<StepNode<Step>>;
export type SequenceInput<Steps extends readonly SequenceItem[]> = Steps extends readonly [infer First, ...unknown[]] ? Initial<First> : unknown;
export type SequenceOutput<Steps extends readonly SequenceItem[]> = Steps extends readonly [...unknown[], infer Last] ? Accepted<Last> : SequenceInput<Steps>;
type ValidStep<Step, Input, Previous, Delta> = Step extends ChildCallable ? ([Previous] extends [MemberInput<Step> | Stable<MemberInput<Step>>] ? true : false) : Step extends SequenceStep<StepNode<Step>, Input, Previous, Delta> ? (Step extends { readonly input: (scope: never) => unknown } ? true : [Previous] extends [MemberInput<StepNode<Step>> | Stable<MemberInput<StepNode<Step>>>] ? true : false) : false;
type ValidSteps<Steps extends readonly SequenceItem[], Input, Previous, Delta> = Steps extends readonly [infer First extends SequenceItem, ...infer Rest extends readonly SequenceItem[]] ? ([ValidStep<First, Input, Previous, Delta>] extends [true] ? ValidSteps<Rest, Input, Accepted<First>, Delta> : false) : Steps extends readonly [] ? true : false;
type CheckedSteps<Steps extends readonly SequenceItem[], Delta> = [SequenceInput<Steps>] extends [never] ? never : ValidSteps<Steps, SequenceInput<Steps>, SequenceInput<Steps>, Delta> extends true ? unknown : never;

type SequenceOptions<Output, Delta> = { readonly output?: OutputDeclaration<Output, Delta> } & ([Delta] extends [never] ? object : { readonly output: OutputDeclaration<Output, Delta> & { readonly delta: (value: unknown) => Delta } });
type SequenceConfiguration<Output, Delta> = [options: SequenceOptions<Output, Delta>] | ([Delta] extends [never] ? [] : never);

interface Entry {
  readonly key: string;
  readonly node: ChildCallable;
  invoke(input: unknown, previous: unknown, children: ChildCalls, output: InvocationOutputWriter<unknown> | undefined): Promise<unknown>;
}

/** A complete fixed pipeline, represented by one ordinary Group. */
export class Sequence<const Steps extends readonly SequenceItem[], Delta = never> extends Group<SequenceInput<Steps>, SequenceOutput<Steps>, {}, Delta> {
  readonly #steps: readonly Entry[];
  declare readonly run: NonNullable<Group<SequenceInput<Steps>, SequenceOutput<Steps>, {}, Delta>['run']>;
  declare readonly output: OutputDeclaration<SequenceOutput<Steps>, Delta> | undefined;

  constructor(steps: Steps & CheckedSteps<NoInfer<Steps>, NoInfer<Delta>>, ...configuration: SequenceConfiguration<NoInfer<SequenceOutput<Steps>>, Delta>) {
    super();
    if (!Array.isArray(steps) || types.isProxy(steps)) throw new TypeError('Sequence steps must be an array');
    const entries: Entry[] = [];
    for (let index = 0; index < steps.length; index++) {
      const item = Object.getOwnPropertyDescriptor(steps, String(index));
      if (!item || !('value' in item)) throw new TypeError('Sequence steps must be present data entries');
      entries.push(prepareStep(item.value, index));
    }
    this.#steps = Object.freeze(entries);
    const outputDeclaration = snapshotOutput(configuration[0]);
    const run: NonNullable<Group<SequenceInput<Steps>, SequenceOutput<Steps>, {}, Delta>['run']> = async (work) => {
      let previous: unknown = work.input;
      const output = 'output' in work ? (work.output as InvocationOutputWriter<unknown>) : undefined;
      for (const step of this.#steps) previous = await step.invoke(work.input, previous, work.children, output);
      // The constructor checks every adjacent input and reception result before erasing the tuple for storage.
      return previous as Stable<SequenceOutput<Steps>>;
    };
    Object.defineProperty(this, 'run', { get: () => run, enumerable: true, configurable: true });
    Object.defineProperty(this, 'output', { get: () => outputDeclaration, enumerable: true, configurable: true });
    // All configuration is checked before claiming any member; add validates the whole ownership batch.
    this.add(...entries.map((entry) => entry.node));
  }

  get steps(): readonly { readonly key: string; readonly node: ChildCallable }[] {
    return Object.freeze(this.#steps.map(({ key, node }) => Object.freeze({ key, node })));
  }
}

function requireConfiguration(value: unknown): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) throw new TypeError('Sequence configuration must be a data object');
}

function readField(configuration: object, name: string): unknown {
  const field = Object.getOwnPropertyDescriptor(configuration, name);
  if (!field && name in configuration) throw new TypeError('Sequence configuration must use own data properties');
  if (field && !('value' in field)) throw new TypeError('Sequence configuration must use data properties');
  return field?.value;
}

function snapshotOutput(options: unknown): OutputDeclaration<unknown, unknown> | undefined {
  if (options === undefined) return undefined;
  requireConfiguration(options);
  const output = readField(options, 'output');
  if (output === undefined) return undefined;
  requireConfiguration(output);
  const result = readField(output, 'result');
  const delta = readField(output, 'delta');
  if (typeof result !== 'function' || (delta !== undefined && typeof delta !== 'function')) throw new TypeError('Sequence output needs result and optional delta functions');
  return Object.freeze({ result: result.bind(output), ...(delta ? { delta: delta.bind(output) } : {}) });
}

function prepareStep(value: unknown, index: number): Entry {
  if (types.isProxy(value)) throw new TypeError('Sequence steps cannot be proxies');
  const direct = value instanceof Callable;
  if (!direct) requireConfiguration(value);
  const configuration = direct ? undefined : (value as object);
  const node = direct ? value : readField(configuration!, 'node');
  requireChildCallable(node);
  const key = (configuration ? readField(configuration, 'key') : undefined) ?? `step:${index}`;
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('Sequence step key must be non-blank');
  const prepare = configuration ? readField(configuration, 'input') : undefined;
  const delta = configuration ? readField(configuration, 'delta') : undefined;
  const result = configuration ? readField(configuration, 'result') : undefined;
  if (result !== undefined) requireConfiguration(result);
  const succeeded = result ? readField(result, 'succeeded') : undefined;
  const failed = result ? readField(result, 'failed') : undefined;
  for (const callback of [prepare, delta, succeeded, failed]) if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Sequence step callbacks must be functions');
  // These functions are heterogeneous after tuple validation. Preserve each callback's receiver.
  const inputFor = typeof prepare === 'function' ? prepare.bind(configuration) : undefined;
  const emit = typeof delta === 'function' ? delta.bind(configuration) : undefined;
  const receive = typeof succeeded === 'function' ? succeeded.bind(result) : undefined;
  const handle = typeof failed === 'function' ? failed.bind(result) : undefined;
  return Object.freeze({
    key,
    node,
    async invoke(input: unknown, previous: unknown, children: ChildCalls, output: InvocationOutputWriter<unknown> | undefined) {
      const scope = Object.freeze({ input, previous, ...(output ? { output } : {}) });
      const childInput: unknown = inputFor ? inputFor(scope) : previous;
      return children.invoke(node, childInput, {
        key,
        ...(emit ? { delta: (value: unknown) => emit(value, scope) } : {}),
        result: {
          ...(receive ? { succeeded: (value: unknown) => receive(value, scope) } : {}),
          ...(handle ? { failed: (failure: unknown) => handle(failure, scope) } : {}),
        },
      });
    },
  });
}
