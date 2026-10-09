import { AttemptDefinition, type AttemptScope, RuntimeError, isNonBlankString } from '@capix-observer/runtime';

import type { ModelOutput } from '../../model/types.js';
import type { ModelOutputContract } from '../../model/contract.js';

export interface ModelAcceptanceInput {
  readonly output: ModelOutput;
}

export class AcceptModelOutput<I extends ModelAcceptanceInput, O> extends AttemptDefinition<I, O> {
  static readonly requires = Object.freeze({});

  readonly name = 'acceptModelOutput';
  readonly label = '接纳模型结果';
  readonly source = 'services/observer/src/attempt/model/accept.ts · AcceptModelOutput';
  readonly callee = 'processing';

  constructor(private readonly contract: ModelOutputContract<I, O>) {
    super();
  }

  execute(context: AttemptScope<I, O>): O {
    checkCompletion(context.currentInput.output);
    const value = parseContent(context.currentInput.output.content);
    return this.contract.accept(value, context.currentInput);
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
    throw new RuntimeError('INVALID_JSON', '模型返回不是完整的 JSON；本次返回未被接纳。');
  }
}
