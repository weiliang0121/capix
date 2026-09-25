import { Attempt, type AttemptContext, type Runtime } from '@capix-observer/runtime';

import type { ModelProvider } from '../../provider.js';
import type { ModelRequest, ModelOutput, Purpose } from '../../model/types.js';

export class InvokeModel extends Attempt<ModelRequest, ModelOutput> {
  readonly name = 'invokeModel';
  readonly label = '调用模型';
  readonly source = 'services/observer/src/attempt/model/invoke.ts · InvokeModel';
  readonly callee = 'provider';

  constructor(
    runtime: Runtime,
    private readonly provider: ModelProvider,
    private readonly purpose: Purpose,
  ) {
    super(runtime);
  }

  protected execute(context: AttemptContext<ModelRequest, ModelOutput>): Promise<ModelOutput> {
    const { settings, signal } = this.runtime.getExecutionContext(context);
    return this.provider.invoke(context.currentInput, this.purpose, AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]));
  }
}
