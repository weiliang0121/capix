import type { ModelProvider } from '../provider.js';
import { ResourceOffer } from '@capix-observer/runtime';
import type { ModelSettings } from '@capix-observer/protocol';

/** Both offers belong to model configuration; timeout is a projected value, not a new resource. */
export const ModelSettingsResource = Object.freeze({
  snapshot: new ResourceOffer('model-settings.snapshot', (settings: Readonly<ModelSettings>): Readonly<ModelSettings> => Object.freeze({ ...settings }), 'binding'),
  timeout: new ResourceOffer('model-settings.timeout', (settings: Readonly<ModelSettings>) => settings.timeoutMs, 'binding'),
});

export const ModelResource = Object.freeze({
  invoke: new ResourceOffer('model.invoke', (provider: ModelProvider): ModelProvider => Object.freeze({ invoke: provider.invoke.bind(provider) })),
});
