import type { ModelRequest, Purpose } from './types.js';
import type { ModelProvider } from '../provider.js';
import { ResourceOffer } from '@capix-observer/runtime';
import type { ModelSettings } from '@capix-observer/protocol';

/** Configuration values and provider access have separate contracts and evidence. */
export const ModelSettingsResource = Object.freeze({
  snapshot: new ResourceOffer<Readonly<ModelSettings>, Readonly<ModelSettings>>('model-settings.snapshot', (settings: Readonly<ModelSettings>) => settings, 'binding', { capture: (settings) => Object.freeze({ ...settings }), describe: (settings) => settings }),
  timeout: new ResourceOffer('model-settings.timeout', (timeoutMs: number) => timeoutMs, 'binding', { describe: (timeoutMs) => ({ timeoutMs }) }),
});

export const ModelResource = Object.freeze({
  invoke: new ResourceOffer(
    'model.invoke',
    (provider: ModelProvider, activity): ModelProvider =>
      Object.freeze({
        invoke: (request: ModelRequest, purpose: Purpose, signal: AbortSignal) => activity.runAsync('invoke', { input: () => ({ model: request.model, purpose }), output: (result) => ({ id: result.id, model: result.model, finishReason: result.finishReason, usage: result.usage }) }, () => provider.invoke(request, purpose, signal)),
      }),
    'access',
    { describe: () => ({ capability: 'model.invoke' }) },
  ),
});
