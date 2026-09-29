import { Attempt, type AttemptContext, type ExecutionContext, type AttemptInvocationBuilder } from '@capix-observer/runtime';

import type { ModelRequest } from '../../model/types.js';
import { checkCapacity } from '../../model/capacity.js';

/** Build the operation-specific request and verify capacity before sending it. */
export class PrepareModelRequest<I> extends Attempt<I, ModelRequest> {
  readonly name = 'prepareModelRequest';
  readonly label = '准备模型请求';
  readonly source = 'services/observer/src/attempt/model/prepare.ts · PrepareModelRequest';
  readonly callee = 'processing';

  constructor(
    invocations: AttemptInvocationBuilder,
    private readonly createRequest: (input: I, execution: ExecutionContext) => ModelRequest,
  ) {
    super(invocations);
  }

  protected execute(context: AttemptContext<I, ModelRequest>): ModelRequest {
    const execution = context.operationContext.executionContext;
    const request = this.createRequest(context.currentInput, execution);
    checkCapacity(request, execution.settings);
    return request;
  }
}
