import type { InvocationOutputReceiver } from '../output/contract.js';
import type { ResourceProvider } from '../resource/offer.js';
import { bindResources, type ResourceBindings } from '../resource/bindings.js';
import type { ProgressReceiver } from '../progress.js';
import type { InvocationProgress } from '../invocation/progress.js';
import type { CallableInvocationStarted } from '../invocation/builders/callable.js';
import type { ChildDefinition, DefinitionInput } from '../definition/children.js';
import type { AnyCallableDefinition, ResolvedCallable } from './declarations.js';

/** Host input establishes one root supply. The callable lifecycle remains independent of this source. */
export interface CallableCallSource<Input, Options, Source> {
  capture(input: Input, options: Options): Source;
  validate?(options: Options): void;
  started?(options: Options): CallableInvocationStarted<any, any, any> | undefined;
  progress?(input: Input, options: Options): ProgressReceiver<InvocationProgress> | undefined;
  output?(input: Input, options: Options): InvocationOutputReceiver<any, any> | undefined;
}

/** An explicit registration selects a source boundary by declaration identity, never by kind. */
export interface CallableSourceBinding<Options, Source, Definition extends ChildDefinition = ChildDefinition> {
  readonly definition: Definition;
  capture?(input: DefinitionInput<Definition>, options: Options): Source;
  started?(options: Options): CallableInvocationStarted<any, any, any> | undefined;
  progress?(options: Options): ProgressReceiver<InvocationProgress> | undefined;
  output?(options: Options): InvocationOutputReceiver<any, any> | undefined;
}

export function bindCallSource<Definition extends ChildDefinition, Options, Source>(definition: Definition, source: Omit<CallableSourceBinding<Options, Source, NoInfer<Definition>>, 'definition'>): CallableSourceBinding<Options, Source, Definition> {
  return Object.freeze({ definition, ...source });
}

export interface CallableSourceAccess {
  readonly resources?: ResourceBindings;
  readonly started?: CallableInvocationStarted<any, any, any>;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<any, any>;
}

interface FixedSource<Options> {
  readonly capture?: (input: unknown, options: Options) => ResourceBindings;
  readonly started?: (options: Options) => CallableInvocationStarted<any, any, any> | undefined;
  readonly progress?: (input: unknown, options: Options) => ProgressReceiver<InvocationProgress> | undefined;
  readonly output?: (input: unknown, options: Options) => InvocationOutputReceiver<any, any> | undefined;
}

/** Fixed per-call host conditions. This is not a source resolver stored in Context or a lifecycle manager. */
export class CallableCallBindings<Options = unknown> {
  constructor(
    private readonly owner: CallableSources<Options>,
    private readonly options: Options,
  ) {
    Object.freeze(this);
  }

  belongsTo(owner: CallableSources<Options>): boolean {
    return this.owner === owner;
  }

  open(definition: AnyCallableDefinition, input: unknown, restoring: boolean): CallableSourceAccess {
    return this.owner.open(definition, input, this.options, restoring);
  }
}

/** Static source wiring. No current input, options, capture or live endpoint is cached here. */
export class CallableSources<Options = unknown> {
  constructor(
    private readonly sources: ReadonlyMap<AnyCallableDefinition, FixedSource<Options>>,
    private readonly validate?: (options: Options) => void,
  ) {}

  begin(options: Options): CallableCallBindings<Options> {
    this.validate?.(options);
    return new CallableCallBindings(this, options);
  }

  require(value: object | undefined): CallableCallBindings<Options> {
    if (!(value instanceof CallableCallBindings) || !value.belongsTo(this)) throw new Error('Call construction belongs to another binding installation');
    return value;
  }

  open(definition: AnyCallableDefinition, input: unknown, options: Options, restoring: boolean): CallableSourceAccess {
    const source = this.sources.get(definition);
    if (!source) throw new Error('Callable source is not registered in this installation');
    return {
      resources: source.capture?.(input, options),
      started: restoring ? undefined : source.started?.(options),
      progress: source.progress?.(input, options),
      output: source.output?.(input, options),
    };
  }
}

export function bindCallableSources<Input, Options, Source>(root: ResolvedCallable, providers: readonly ResourceProvider<Source>[], source: CallableCallSource<Input, Options, Source>, bindings: readonly CallableSourceBinding<Options, Source>[]): CallableSources<Options> {
  const registered = new Map<ChildDefinition, CallableSourceBinding<Options, Source>>();
  for (const binding of bindings) {
    if (binding.definition === root.definition) throw new Error('The root callable source must be configured through source');
    if (registered.has(binding.definition)) throw new Error('Duplicate callable source binding');
    registered.set(binding.definition, binding);
  }
  const fixed = new Map<AnyCallableDefinition, FixedSource<Options>>();
  const rootCapture = source.capture.bind(source);
  const rootStarted = source.started?.bind(source);
  const rootProgress = source.progress?.bind(source);
  const rootOutput = source.output?.bind(source);
  const validate = source.validate?.bind(source);
  const visit = (resolved: ResolvedCallable): void => {
    if (fixed.has(resolved.definition)) return;
    const capture = bindResources(resolved.supply, providers);
    if (resolved === root) {
      fixed.set(resolved.definition, {
        capture: (input, options) => capture(rootCapture(input as Input, options)),
        started: rootStarted,
        progress: rootProgress ? (input, options) => rootProgress(input as Input, options) : undefined,
        output: rootOutput ? (input, options) => rootOutput(input as Input, options) : undefined,
      });
    } else {
      const binding = registered.get(resolved.definition as ChildDefinition);
      const select = binding?.capture?.bind(binding);
      const progress = binding?.progress?.bind(binding);
      const output = binding?.output?.bind(binding);
      fixed.set(resolved.definition, {
        capture: select ? (input, options) => capture(select(input, options)) : undefined,
        started: binding?.started?.bind(binding),
        progress: progress ? (_input, options) => progress(options) : undefined,
        output: output ? (_input, options) => output(options) : undefined,
      });
    }
    for (const member of resolved.members) visit(member);
  };
  visit(root);
  for (const definition of registered.keys()) {
    if (!fixed.has(definition)) throw new Error('Call source requires a registered member');
  }
  return new CallableSources(fixed, validate);
}
