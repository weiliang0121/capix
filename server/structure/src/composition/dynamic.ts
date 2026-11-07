import { types } from 'node:util';
import { Group } from '../group.js';
import type { MemberInput } from './input.js';
import type { ChildCallable } from '../definition/children.js';
import type { CallableInput, CallableOutput, Stable } from '@capix/contracts';
import type { MemberRegistration, NamedMembers } from '../definition/composition.js';
import { checkMemberName } from '../members.js';

export type DynamicCall<Options extends NamedMembers> = { [Name in keyof Options & string]: { readonly kind: 'call'; readonly option: Name; readonly input: MemberInput<Options[Name]> | Stable<MemberInput<Options[Name]>> } }[keyof Options & string];
export type DynamicFinish<Output> = { readonly kind: 'finish'; readonly value: Output };
export type DynamicDecision<Options extends NamedMembers, Output> = DynamicCall<Options> | DynamicFinish<Output>;

type FinishValue<Value> = Value extends DynamicFinish<infer Output> ? Output : never;
export type DynamicOutput<Decision extends ChildCallable> = FinishValue<CallableOutput<Decision>>;

type DecisionCheck<Options extends NamedMembers, Decision extends ChildCallable> = [CallableOutput<Decision>] extends [DynamicDecision<Options, unknown>] ? ([CallableInput<Decision>] extends [MemberInput<Decision>] ? unknown : never) : never;

export interface DynamicConfiguration<Options extends NamedMembers, Decision extends ChildCallable> {
  readonly options: MemberRegistration<Options>;
  readonly decide: Decision & NoInfer<DecisionCheck<Options, Decision>>;
  /** Maximum action calls; one final decision may still finish after the last action. */
  readonly maxSteps?: number;
}

/** A fixed Group preset; candidate names select members without creating named Work ports. */
export class Dynamic<const Options extends NamedMembers, Decision extends ChildCallable> extends Group<MemberInput<Decision>, DynamicOutput<Decision>> {
  declare readonly run: NonNullable<Group<MemberInput<Decision>, DynamicOutput<Decision>>['run']>;
  readonly #maxSteps: number;

  constructor(configuration: DynamicConfiguration<Options, Decision>) {
    super();
    if (!configuration || typeof configuration !== 'object' || types.isProxy(configuration)) throw new TypeError('Dynamic configuration must be an object');
    const options = snapshotOptions(configuration.options);
    const decision: ChildCallable = configuration.decide;
    const maxSteps = checkMaxSteps(configuration.maxSteps ?? 8);
    // One complete ownership check prevents a failed constructor from claiming any member.
    this.add(...options.values(), decision);
    this.#maxSteps = maxSteps;
    const run: NonNullable<Group<MemberInput<Decision>, DynamicOutput<Decision>>['run']> = async (work) => {
      for (let step = 0; step <= maxSteps; step++) {
        const next: unknown = await work.children.invoke(decision, work.input, { key: `decision:${step}` });
        const selected = checkDecision(next, options);
        if (selected.kind === 'finish') return selected.value as Stable<DynamicOutput<Decision>>;
        if (step < maxSteps) await work.children.invoke(selected.node, selected.input, { key: `option:${step}:${selected.option}` });
      }
      throw new Error(`Dynamic exceeded ${maxSteps} action steps`);
    };
    // Build can fix this entry, but authors cannot replace the preset's progression.
    Object.defineProperty(this, 'run', { get: () => run, enumerable: true, configurable: true });
  }

  get maxSteps(): number {
    return this.#maxSteps;
  }
}

function checkMaxSteps(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Dynamic maxSteps must be a non-negative safe integer');
  return value;
}

function snapshotOptions(options: NamedMembers): ReadonlyMap<string, ChildCallable> {
  if (!options || typeof options !== 'object' || Array.isArray(options) || types.isProxy(options)) throw new TypeError('Dynamic options must be an object');
  if (Object.getOwnPropertySymbols(options).length) throw new TypeError('Dynamic option names must be strings');
  const entries: [string, ChildCallable][] = [];
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) {
    checkMemberName(name);
    if (!('value' in descriptor)) throw new TypeError('Dynamic options must use data properties');
    entries.push([name, descriptor.value]);
  }
  return new Map(entries);
}

function checkDecision(value: unknown, options: ReadonlyMap<string, ChildCallable>): { readonly kind: 'finish'; readonly value: unknown } | { readonly kind: 'call'; readonly option: string; readonly node: ChildCallable; readonly input: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Dynamic decision must be a call or finish object');
  const decision = value as Record<string, unknown>;
  if (decision.kind === 'finish' && Object.hasOwn(decision, 'value')) return { kind: 'finish', value: decision.value };
  if (decision.kind !== 'call' || typeof decision.option !== 'string' || !Object.hasOwn(decision, 'input')) throw new TypeError('Dynamic decision must be a call or finish object');
  const node = options.get(decision.option);
  if (!node) throw new Error(`Dynamic option is not registered: ${decision.option}`);
  return { kind: 'call', option: decision.option, node, input: decision.input };
}
