import { Attempt } from '../attempt.js';
import type { AttemptContext } from '../../context/attempt.js';
import type { Runtime } from '../../runtime/runtime.js';
import type { ModelProvider } from '../../provider.js';
import type { ModelRequest, ModelOutput, Purpose } from '../../../shared/types.js';

export class InvokeModel extends Attempt<ModelRequest, ModelOutput> {
  readonly name = 'invokeModel';
  readonly label = '调用模型';
  readonly source = 'src/server/attempt/model/invoke.ts · InvokeModel';
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
