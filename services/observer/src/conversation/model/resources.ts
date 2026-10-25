import type { ModelInteractions, ModelInteractionCreator, ModelInteractionReader } from './interactions.js';
import { ResourceOffer, type ResourceActivity } from '@capix/server-runtime';
import type { ModelSettings } from '@capix/protocol';

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

/** Starting an interaction returns its identity synchronously; its lifetime remains independent. */
function exposeModelCreator(interactions: ModelInteractions, activity: ResourceActivity): ModelInteractionCreator {
  return Object.freeze<ModelInteractionCreator>({
    start: (request, purpose, controls) => activity.runSync('start', { input: () => ({ model: request.model, purpose }), output: (ref) => ref }, () => interactions.start(request, purpose, controls)),
  });
}

/** Subscription registration must hand cleanup to its caller or undo that registration on failure. */
function exposeModelReader(interactions: ModelInteractions, activity: ResourceActivity): ModelInteractionReader {
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
    wait: (ref, controls) => activity.runAsync('wait', { input: () => ref, output: (result) => ({ kind: result.kind, interaction: result.interaction }) }, () => interactions.wait(ref, controls)),
    result: (ref, controls) => activity.runAsync('result', { input: () => ref, output: (result) => ({ id: result.id, model: result.model, finishReason: result.finishReason, usage: result.usage }) }, () => interactions.result(ref, controls)),
  });
}
