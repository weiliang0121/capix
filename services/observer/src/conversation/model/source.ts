import { Initializer } from '@weiliang0121/capix-runtime';
import type { ConversationFailure } from '@weiliang0121/capix-protocol';
import { isFunction } from 'es-toolkit/predicate';
import type { ModelInitialization, ModelProvider } from './types.js';

/** Preserve lazy initialization and expose only a failure already retained by the initializer. */
export class ModelSource extends Initializer<ModelProvider> {
  private unavailable: ConversationFailure | undefined;

  constructor(provider: ModelInitialization) {
    super(() => {
      try {
        const model = isFunction(provider) ? provider() : provider;
        if (!model || !isFunction(model.invoke)) throw new TypeError('Invalid model provider');
        return model;
      } catch (error) {
        this.unavailable = Object.freeze({ code: 'MODEL_INITIALIZATION_FAILED', message: '模型能力初始化失败；需要修复配置并重新建立服务环境。' });
        throw error;
      }
    });
  }

  get failure(): ConversationFailure | undefined {
    if (this.unavailable) return this.unavailable;
    const failure = this.initialized ? this.get().unavailable : undefined;
    return failure ? Object.freeze({ code: failure.code, message: failure.message }) : undefined;
  }
}
