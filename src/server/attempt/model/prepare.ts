import { Attempt } from '../attempt.js';
import type { AttemptContext } from '../../context/attempt.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { Runtime } from '../../runtime/runtime.js';
import type { ModelRequest } from '../../../shared/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequest<I> extends Attempt<I, ModelRequest> {
  readonly name = 'prepareModelRequest';
  readonly label = '准备模型请求';
  readonly source = 'src/server/attempt/model/prepare.ts · PrepareModelRequest';
  readonly callee = 'processing';

  constructor(
    runtime: Runtime,
    private readonly createRequest: (input: I, execution: ExecutionContext) => ModelRequest,
  ) {
    super(runtime);
  }

  protected execute(context: AttemptContext<I, ModelRequest>): ModelRequest {
    const execution = this.runtime.getExecutionContext(context);
    const request = this.createRequest(context.currentInput, execution);
    checkCapacity(request, execution.settings);
    return request;
  }
}
