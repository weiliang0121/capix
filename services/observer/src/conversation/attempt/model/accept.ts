import { invocationRecording } from '@capix/server-runtime/recording';
import { modelOutputRejected } from '../../model/rejection.js';
import { AttemptDefinition, type AttemptContextView, RuntimeError, isNonBlankString } from '@capix/server-runtime';

import type { ModelOutput } from '../../model/types.js';
import type { ModelOutputContract } from '../../model/contract.js';

export interface ModelAcceptanceInput {
  readonly output: ModelOutput;
}

export class AcceptModelOutputDefinition<Input extends ModelAcceptanceInput, Output> extends AttemptDefinition<Input, Output> {
  readonly observation = [invocationRecording()];
  static readonly requires = Object.freeze({});

  readonly raises = [modelOutputRejected];
  readonly run = { requires: AcceptModelOutputDefinition.requires, execute: this.execute.bind(this) };

  readonly name = 'acceptModelOutput';
  readonly label = '接纳模型结果';
  readonly source = 'services/observer/src/conversation/attempt/model/accept.ts · AcceptModelOutputDefinition';
  readonly callee = 'processing';

  constructor(private readonly contract: ModelOutputContract<Input, Output>) {
    super();
  }

  private execute(context: AttemptContextView<Input, Output>): Output {
    checkCompletion(context.currentInput.output);
    try {
      const value = parseContent(context.currentInput.output.content);
      return this.contract.accept(value, context.currentInput);
    } catch (error) {
      if (error instanceof RuntimeError && (error.code === 'INVALID_JSON' || error.code === 'EMPTY_OUTPUT' || error.code === 'OUTPUT_SHAPE')) {
        throw modelOutputRejected.create(error.message, { code: error.code, output: context.currentInput.output }, { cause: error });
      }
      throw error;
    }
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
