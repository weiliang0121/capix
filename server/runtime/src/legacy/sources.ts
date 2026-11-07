import { InvocationResources, type InvocationProgress } from '@capix/invocation';
import type { ChildCallable } from '@capix/structure';
import type { InvocationOutputReceiver, CallableInput } from '@capix/contracts';
import type { ResourceProvider } from '@capix/resources';
import { ResourceSupply, checkResourceProviders, resourceRequests } from '@capix/resources';
import type { ProgressReceiver } from '@capix/changes';
import type { CallableInvocationStarted } from '../construction/invocation.js';
import type { AnyCallable, ResolvedCallable } from '../binding/declarations.js';
import { CallableCallScope, type PreparedCall, type CallInstallation } from '../binding/calls.js';
import type { CallableFeedback } from '../construction/feedback.js';
import { stableValue, type Stable } from '@capix/contracts';

/** Host input establishes one root supply. The callable lifecycle remains independent of this source. */
export interface CallableCallSource<Input, Options, Source> {
  capture(input: Stable<Input>, options: Options): Source;
  validate?(options: Options): void;
  started?(options: Options): CallableInvocationStarted<any, any, any> | undefined;
  progress?(input: Stable<Input>, options: Options): ProgressReceiver<InvocationProgress> | undefined;
  output?(input: Stable<Input>, options: Options): InvocationOutputReceiver<any, any> | undefined;
}

/** An explicit registration selects a source boundary by declaration identity, never by kind. */
export interface CallableSourceBinding<Options, Source, Definition extends ChildCallable = ChildCallable> {
  readonly definition: Definition;
  capture?(input: Stable<CallableInput<Definition>>, options: Options): Source;
  started?(options: Options): CallableInvocationStarted<any, any, any> | undefined;
  progress?(options: Options): ProgressReceiver<InvocationProgress> | undefined;
  output?(options: Options): InvocationOutputReceiver<any, any> | undefined;
}

export function bindCallSource<Definition extends ChildCallable, Options, Source>(definition: Definition, source: Omit<CallableSourceBinding<Options, Source, NoInfer<Definition>>, 'definition'>): CallableSourceBinding<Options, Source, Definition> {
  return Object.freeze({ definition, ...source });
}

interface FixedSource<Options> {
  readonly capture?: (input: unknown, options: Options) => InvocationResources;
  readonly started?: (options: Options) => CallableInvocationStarted<any, any, any> | undefined;
  readonly progress?: (input: unknown, options: Options) => ProgressReceiver<InvocationProgress> | undefined;
  readonly output?: (input: unknown, options: Options) => InvocationOutputReceiver<any, any> | undefined;
}

/** Legacy host-source adapter. New resource assembly uses CallableCalls instead. */
export class CallableSources<Options = unknown> implements CallInstallation<Options> {
  constructor(
    private readonly sources: ReadonlyMap<AnyCallable, FixedSource<Options>>,
    private readonly validate?: (options: Options) => void,
  ) {}

  begin(options: Options, feedback?: CallableFeedback): CallableCallScope<Options> {
    this.validate?.(options);
    return new CallableCallScope(this, options, feedback);
  }

  require(value: object | undefined): CallableCallScope<Options> {
    if (!(value instanceof CallableCallScope) || !value.belongsTo(this)) throw new Error('Call construction belongs to another binding installation');
    return value;
  }

  prepare(definition: AnyCallable, input: unknown, options: Options, restoring: boolean): PreparedCall {
    const source = this.sources.get(definition);
    if (!source) throw new Error('Callable source is not registered in this installation');
    const fixedInput = stableValue(input);
    return {
      supply: source.capture?.(fixedInput, options).supply,
      started: restoring ? undefined : source.started?.(options),
      progress: source.progress?.(fixedInput, options),
      output: source.output?.(fixedInput, options),
    };
  }
}

export function bindCallableSources<Input, Options, Source>(root: ResolvedCallable, providers: readonly ResourceProvider<Source>[], source: CallableCallSource<Input, Options, Source>, bindings: readonly CallableSourceBinding<Options, Source>[]): CallableSources<Options> {
  const registered = new Map<ChildCallable, CallableSourceBinding<Options, Source>>();
  for (const binding of bindings) {
    if (binding.definition === root.definition) throw new Error('The root callable source must be configured through source');
    if (registered.has(binding.definition)) throw new Error('Duplicate callable source binding');
    registered.set(binding.definition, binding);
  }
  const fixed = new Map<AnyCallable, FixedSource<Options>>();
  const rootCapture = source.capture.bind(source);
  const rootStarted = source.started?.bind(source);
  const rootProgress = source.progress?.bind(source);
  const rootOutput = source.output?.bind(source);
  const validate = source.validate?.bind(source);
  const visit = (resolved: ResolvedCallable): void => {
    if (fixed.has(resolved.definition)) return;
    const requests = resourceRequests(resolved.supply);
    checkResourceProviders(requests, providers);
    const offers = new Set(requests.map((request) => request.offer));
    const selected = providers.filter((provider) => offers.has(provider.offer)).map((provider) => Object.freeze({ offer: provider.offer, readMaterial: provider.readMaterial.bind(provider) }));
    const capture = (value: Source) => new InvocationResources(resolved.supply, ResourceSupply.capture(selected, value).entries);
    if (resolved === root) {
      fixed.set(resolved.definition, {
        capture: (input, options) => capture(rootCapture(input as Stable<Input>, options)),
        started: rootStarted,
        progress: rootProgress ? (input, options) => rootProgress(input as Stable<Input>, options) : undefined,
        output: rootOutput ? (input, options) => rootOutput(input as Stable<Input>, options) : undefined,
      });
    } else {
      const binding = registered.get(resolved.definition as ChildCallable);
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
