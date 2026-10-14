import { isEqual } from 'es-toolkit/predicate';
import { checkLeafResult } from '../../operations/checkpoint.js';
import { modelOutputSchema } from '../../model/interactions.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import { modelOutputRejected } from '../../model/rejection.js';
import { AttemptDefinition, cloneCheckpointValue, type CheckpointValue, type InvocationWorkView, type InvocationCheckpointDefinition, type AttemptContextView, RuntimeError, isNonBlankString } from '@capix/server-runtime';

import type { ModelOutput } from '../../model/types.js';
import type { ModelOutputContract } from '../../model/contract.js';

export interface ModelAcceptanceInput {
  readonly output: ModelOutput;
}

export class AcceptModelOutputDefinition<Input extends ModelAcceptanceInput, Output> extends AttemptDefinition<Input, Output> {
  readonly checkpoint: InvocationCheckpointDefinition<Input, Output, AttemptContextView<Input, Output>>;
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
    const input = {
      encode: cloneCheckpointValue,
      decode: (value: CheckpointValue) => {
        const input = cloneCheckpointValue(value) as unknown as Input;
        modelOutputSchema.parse(input.output);
        return input;
      },
    };
    const output = { encode: cloneCheckpointValue, decode: (value: CheckpointValue) => cloneCheckpointValue(value) as Output };
    this.checkpoint = {
      key: 'observer.accept-model-output',
      version: 1,
      input,
      output,
      points: {
        result: {
          state: output,
          check: (frame, result) => {
            checkLeafResult(frame);
            const basis = input.decode(frame.currentInput);
            checkCompletion(basis.output);
            if (!isEqual(this.contract.accept(parseContent(basis.output.content), basis), result)) throw new Error('Accepted model checkpoint differs from declared output');
          },
          resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, result: Output) => result },
        },
      },
    };
  }

  private execute(context: AttemptContextView<Input, Output>, invocation: InvocationWorkView<Input, Output, AttemptContextView<Input, Output>>): Output {
    checkCompletion(context.currentInput.output);
    try {
      const value = parseContent(context.currentInput.output.content);
      const output = this.contract.accept(value, context.currentInput);
      invocation.checkpoint?.save('result', output);
      return output;
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
