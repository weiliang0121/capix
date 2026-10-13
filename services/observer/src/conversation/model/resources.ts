import type { ModelInteractions, ModelInteractionCreator, ModelInteractionReader } from './interactions.js';
import { ResourceOffer } from '@capix/server-runtime';
import type { ModelSettings } from '@capix/protocol';

/** Configuration values and provider access have separate contracts and evidence. */
export const ModelSettingsResource = Object.freeze({
  snapshot: new ResourceOffer<Readonly<ModelSettings>, Readonly<ModelSettings>>('model-settings.snapshot', (settings: Readonly<ModelSettings>) => settings, 'binding', { capture: (settings) => Object.freeze({ ...settings }), describe: (settings) => settings }),
  timeout: new ResourceOffer('model-settings.timeout', (timeoutMs: number) => timeoutMs, 'binding', { describe: (timeoutMs) => ({ timeoutMs }) }),
});

export const ModelResource = Object.freeze({
  create: new ResourceOffer(
    'model-interaction.create',
    (interactions: ModelInteractions, activity): ModelInteractionCreator =>
      Object.freeze<ModelInteractionCreator>({
        start: (request, purpose, controls) => activity.runSync('start', { input: () => ({ model: request.model, purpose }), output: (ref) => ref }, () => interactions.start(request, purpose, controls)),
      }),
    'access',
    { describe: () => ({ capability: 'model-interaction.create' }) },
  ),
  read: new ResourceOffer(
    'model-interaction.read',
    (interactions: ModelInteractions, activity): ModelInteractionReader =>
      Object.freeze<ModelInteractionReader>({
        subscribe: (ref, receiver) => {
          let detach: (() => void) | undefined;
          try {
            return activity.runSync('subscribe', { input: () => ref, output: () => ({ attached: true }) }, () => {
              detach = interactions.subscribe(ref, receiver);
              return detach;
            });
          } catch (error) {
            // A strict returned observation can fail after registration, before the caller owns cleanup.
            detach?.();
            throw error;
          }
        },
        wait: (ref, controls) => activity.runAsync('wait', { input: () => ref, output: (result) => ({ kind: result.kind, interaction: result.interaction }) }, () => interactions.wait(ref, controls)),
        result: (ref, controls) => activity.runAsync('result', { input: () => ref, output: (result) => ({ id: result.id, model: result.model, finishReason: result.finishReason, usage: result.usage }) }, () => interactions.result(ref, controls)),
      }),
    'access',
    { describe: () => ({ capability: 'model-interaction.read' }) },
  ),
});
