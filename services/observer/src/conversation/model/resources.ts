import type { ModelInteractions, ModelInteractionCreator, ModelInteractionRef, ModelInteractionResult, ModelInteractionExpectation } from './interactions.js';
import { type ProgressReceiver } from '@weiliang0121/capix-changes';
import { ResourceOffer, type ResourceEndpointActivity } from '@weiliang0121/capix-resources';
import { type OperationOptions, type OperationResult } from '@weiliang0121/capix-resources/operation';
import type { ModelSettings } from '@weiliang0121/capix-protocol';
import type { ModelOutput, ModelTextDelta } from './types.js';

type WaitOptions = OperationOptions<ModelInteractionResult, unknown, unknown> & { readonly signal?: AbortSignal; readonly waitMs: number };
type ResultOptions = OperationOptions<ModelOutput, unknown, unknown> & { readonly signal?: AbortSignal; readonly expected?: ModelInteractionExpectation };

/** A resource endpoint adds controlled operation reception to the independent interaction entity. */
export interface ModelInteractionReader {
  subscribe(interaction: ModelInteractionRef, receiver: ProgressReceiver<ModelTextDelta>): () => void;
  wait<const Options extends WaitOptions>(interaction: ModelInteractionRef, options: Options): Promise<OperationResult<ModelInteractionResult, Options>>;
  result<const Options extends ResultOptions = {}>(interaction: ModelInteractionRef, options?: Options): Promise<OperationResult<ModelOutput, Options>>;
}

/** Configuration values and provider access have separate contracts and evidence. */
export const ModelSettingsResource = Object.freeze({
  snapshot: new ResourceOffer<Readonly<ModelSettings>, Readonly<ModelSettings>>({
    name: 'model-settings.snapshot',
    expose: (settings: Readonly<ModelSettings>) => settings,
    timing: 'binding',
    capture: (settings) => Object.freeze({ ...settings }),
    describe: (settings) => settings,
  }),
  timeout: new ResourceOffer({
    name: 'model-settings.timeout',
    expose: (timeoutMs: number) => timeoutMs,
    timing: 'binding',
    describe: (timeoutMs) => ({ timeoutMs }),
  }),
});

export const ModelResource = Object.freeze({
  create: new ResourceOffer({
    name: 'model-interaction.create',
    expose: exposeModelCreator,
    describe: () => ({ capability: 'model-interaction.create' }),
  }),
  read: new ResourceOffer({
    name: 'model-interaction.read',
    expose: exposeModelReader,
    describe: () => ({ capability: 'model-interaction.read' }),
  }),
});

/** Synchronous identity handoff keeps the first checkpoint adjacent to dispatch; the external lifetime remains independent. */
function exposeModelCreator(interactions: ModelInteractions, activity: ResourceEndpointActivity): ModelInteractionCreator {
  return Object.freeze<ModelInteractionCreator>({
    start: (request, purpose, controls) => activity.runSync('start', { input: () => ({ model: request.model, purpose }), output: (ref) => ref }, () => interactions.start(request, purpose, controls)),
  });
}

/** Subscription registration must hand cleanup to its caller or undo that registration on failure. */
function exposeModelReader(interactions: ModelInteractions, activity: ResourceEndpointActivity): ModelInteractionReader {
  return Object.freeze<ModelInteractionReader>({
    subscribe: (ref, receiver) => {
      let detach: (() => void) | undefined;
      try {
        return activity.runSync('subscribe', { input: () => ref, output: () => ({ attached: true }) }, () => {
          detach = interactions.subscribe(ref, receiver);
          return detach;
        });
      } catch (error) {
        // A strict returned observation can fail before the caller owns cleanup.
        detach?.();
        throw error;
      }
    },
    wait: (ref, options) => activity.operate('wait', { input: () => ref, output: (result: ModelInteractionResult) => ({ kind: result.kind, interaction: result.interaction }) }, (operation) => interactions.wait(ref, { signal: operation.signal ?? options.signal ?? new AbortController().signal, waitMs: options.waitMs }), options),
    result: (ref, options) => activity.operate('result', { input: () => ref, output: (result: ModelOutput) => ({ id: result.id, model: result.model, finishReason: result.finishReason, usage: result.usage }) }, (operation) => interactions.result(ref, { signal: operation.signal ?? options?.signal ?? new AbortController().signal, expected: options?.expected }), options),
  });
}
