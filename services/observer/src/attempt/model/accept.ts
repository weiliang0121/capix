import { Attempt, type AttemptContext, type Runtime, RuntimeError, isNonBlankString } from '@capix-observer/runtime';

import type { ModelOutput } from '../../model/types.js';
import type { ModelOutputContract } from '../../model/contract.js';

export class AcceptModelOutput<I, O> extends Attempt<ModelOutput, O> {
  readonly name = 'acceptModelOutput';
  readonly label = '接纳模型结果';
  readonly source = 'services/observer/src/attempt/model/accept.ts · AcceptModelOutput';
  readonly callee = 'processing';

  constructor(
    runtime: Runtime,
    private readonly contract: ModelOutputContract<I, O>,
  ) {
    super(runtime);
  }

  protected execute(context: AttemptContext<ModelOutput, O>): O {
    checkCompletion(context.currentInput);
    const value = parseContent(context.currentInput.content);
    const operation = this.runtime.getOperationContext(context);
    const execution = this.runtime.getExecutionContext(context);
    return this.contract.accept(value, operation.currentInput as I, execution);
  }
}

function checkCompletion(output: ModelOutput): void {
  if (output.finishReason !== 'stop') throw new RuntimeError('INCOMPLETE_OUTPUT', `模型未正常结束：${output.finishReason}。原始返回保留，未作为完整结果接纳。`);
}

function parseContent(content: string): unknown {
  if (!isNonBlankString(content)) throw new RuntimeError('EMPTY_OUTPUT', '模型返回了空内容。');
  try {
    return JSON.parse(content);
  } catch {
    throw new RuntimeError('INVALID_JSON', '模型返回不是完整的 JSON；未自动修复或重试。');
  }
}
