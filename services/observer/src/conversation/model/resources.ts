import type { ModelRequest, Purpose } from './types.js';
import type { ModelProvider, ModelInvocation } from './types.js';
import { ResourceOffer, RuntimeError, InvocationCancelled, isInvocationCancelled } from '@capix/server-runtime';
import type { ModelSettings } from '@capix/protocol';

/** Configuration values and provider access have separate contracts and evidence. */
export const ModelSettingsResource = Object.freeze({
  snapshot: new ResourceOffer<Readonly<ModelSettings>, Readonly<ModelSettings>>('model-settings.snapshot', (settings: Readonly<ModelSettings>) => settings, 'binding', { capture: (settings) => Object.freeze({ ...settings }), describe: (settings) => settings }),
  timeout: new ResourceOffer('model-settings.timeout', (timeoutMs: number) => timeoutMs, 'binding', { describe: (timeoutMs) => ({ timeoutMs }) }),
});

export const ModelResource = Object.freeze({
  invoke: new ResourceOffer(
    'model.invoke',
    (provider: ModelProvider, activity): ModelInvocation =>
      Object.freeze({
        invoke: (request: ModelRequest, purpose: Purpose, controls: { readonly signal: AbortSignal; readonly timeoutMs: number }) =>
          activity.runAsync('invoke', { input: () => ({ model: request.model, purpose }), output: (result) => ({ id: result.id, model: result.model, finishReason: result.finishReason, usage: result.usage }) }, async () => {
            const timeout = AbortSignal.timeout(controls.timeoutMs);
            const signal = AbortSignal.any([controls.signal, timeout]);
            try {
              const output = await provider.invoke(request, purpose, signal);
              if (signal.aborted) throw signal.reason;
              return output;
            } catch (error) {
              if (!isInvocationCancelled(error, signal) && !(signal.aborted && error === signal.reason)) throw error;
              if (controls.signal.aborted && signal.reason === controls.signal.reason) throw new InvocationCancelled(controls.signal, { cause: error });
              if (timeout.aborted && signal.reason === timeout.reason) throw new RuntimeError('MODEL_TIMEOUT', '模型调用超过时限。', undefined, { cause: error });
              throw error;
            }
          }),
      }),
    'access',
    { describe: () => ({ capability: 'model.invoke' }) },
  ),
});
