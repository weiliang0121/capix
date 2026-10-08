import { Initializer, bindResources, TranscriptRangeRef, type Transcript, type Runtime, type ExecutionOptions, type ExecutionStarted, type ExecutionContext } from '@capix-observer/runtime';
import { isFunction } from 'es-toolkit/predicate';
import type { ModelSettings, Message, GenerationOutput, ConversationUpdate } from '@capix-observer/protocol';
import type { ModelProvider } from '../provider.js';
import { ObserverRuntimeDefinition } from './definition.js';
import { observerEntryRequests, type ObserverExecutionResources } from './resources.js';

export interface ObserverExecutionOptions extends ExecutionOptions {
  settings: ModelSettings;
  transcript?: Transcript;
}
interface ObserverCallOptions extends ObserverExecutionOptions {
  deliver?: (update: ConversationUpdate) => void;
}
const ignoreDelivery = (_update: ConversationUpdate): void => {};

/** Application binding: broader environment access stays here, outside business execution. */
export class ObserverBinding {
  readonly model: Initializer<ModelProvider>;
  readonly execution;
  private readonly entry;

  constructor(
    readonly runtime: Runtime,
    readonly definition: ObserverRuntimeDefinition,
  ) {
    const model = definition.model;
    this.model = new Initializer(isFunction(model) ? model : () => model);
    const binding = runtime.bind(definition);
    this.execution = binding.execution('conversation', {
      validate: (options: ObserverCallOptions) => {
        if (options.transcript && options.transcript !== runtime.context.transcript) throw new Error('Execution Transcript belongs to another Runtime');
      },
      capture: (_input, options: ObserverCallOptions) => {
        const settings = Object.freeze({ ...options.settings });
        const transcript = runtime.context.transcript;
        const transcriptRange = new TranscriptRangeRef(transcript, transcript.activeStart, transcript.length);
        return { source: { settings, transcriptRange, runtime: runtime.context, model: this.model, delivery: options.deliver ?? ignoreDelivery }, record: { settings, transcriptRange } };
      },
    });
    this.entry = bindResources(observerEntryRequests, definition.providers);
  }

  call(input: Readonly<Message>, options: ObserverExecutionOptions, started?: ExecutionStarted<Readonly<Message>, GenerationOutput, ObserverExecutionResources>) {
    return this.submit(() => input, options, started);
  }

  submit(accept: () => Readonly<Message>, options: ObserverCallOptions, started?: ExecutionStarted<Readonly<Message>, GenerationOutput, ObserverExecutionResources>) {
    return this.execution.submit(
      () => {
        const input = accept();
        if (!options.signal?.aborted) {
          const resources = this.entry({ settings: options.settings, runtime: this.runtime.context, model: this.model, delivery: ignoreDelivery }).values;
          this.definition.admit(input, resources);
        }
        return input;
      },
      options,
      started,
    );
  }

  async converse(accept: () => Readonly<Message>, options: ObserverExecutionOptions, deliver: (update: ConversationUpdate) => void): Promise<void> {
    let current: ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources> | undefined;
    await this.submit(accept, { ...options, deliver }, (context) => {
      current = context;
      deliver({ type: 'started', contextId: context.id, inputIndex: context.resources.values.history.end - 1 });
    });
    deliver({ type: 'completed', contextId: current!.id });
  }
}
