import type { InvocationOutputReceiver } from '../output/contract.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { ExecutionInvocationCallbacks } from '../execution/execution.js';
import type { ExecutionBindingResolver } from '../context/runtime.js';
import type { ResourceProvider } from '../resource/offer.js';
import { bindResources, type ResourceRequirements } from '../resource/bindings.js';
import type { ProgressReceiver } from '../progress/channel.js';
import type { InvocationProgress } from '../invocation/progress.js';
import { collectDefinitionRequirements } from './resources.js';

type AnyExecutionDefinition = ExecutionDefinition<any, any, any, any, any, any, any>;

/** Capture per-call inputs and resources from independent supplies at entry and call boundaries. */
export interface RuntimeCallSource<Input, Options, Source> {
  output?(input: Input, options: Options): InvocationOutputReceiver<any, any> | undefined;
  executionOutput?(definition: AnyExecutionDefinition, options: Options): InvocationOutputReceiver<any, any> | undefined;
  validate?(options: Options): void;
  runtime?(input: Input, options: Options): Source;
  entry(input: unknown, options: Options, definition: AnyExecutionDefinition): Source;
  capture(input: unknown, options: Options, definition: AnyExecutionDefinition): Source;
  callbacks?(definition: AnyExecutionDefinition, options: Options): ExecutionInvocationCallbacks<any, any, any> | undefined;
  /** One passive receiver for the R call and its complete invocation subtree. */
  progress?(input: Input, options: Options): ProgressReceiver<InvocationProgress> | undefined;
  /** Optional E-subtree receiver selected by declaration, independent of the R receiver. */
  executionProgress?(definition: AnyExecutionDefinition, options: Options): ProgressReceiver<InvocationProgress> | undefined;
}

/** Bind supply lookup now; capture actual resources only at each E entry and work boundary. */
export function bindExecutionSources<Input, Options, Source>(definitions: readonly AnyExecutionDefinition[], providers: readonly ResourceProvider<Source>[], source: RuntimeCallSource<Input, Options, Source>, observationProvides?: ResourceRequirements): (input: Input, options: Options) => ExecutionBindingResolver {
  const supplies = new Map(
    definitions.map((definition) => {
      const entry = bindResources(definition.entry?.requires ?? {}, providers);
      const capture = bindResources(collectDefinitionRequirements(definition, observationProvides), providers);
      return [definition, { entry, capture }];
    }),
  );
  return (_input, options) => ({
    get(definition) {
      const supply = supplies.get(definition);
      if (!supply) throw new Error('Execution definition is not declared by this Runtime');
      return {
        entry: (input) => supply.entry(source.entry(input, options, definition)),
        capture: (input) => supply.capture(source.capture(input, options, definition)),
        callbacks: source.callbacks?.(definition, options),
        progress: source.executionProgress?.(definition, options),
        output: source.executionOutput?.(definition, options),
      };
    },
  });
}
