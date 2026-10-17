import { isEqual } from 'es-toolkit/predicate';
import { checkLeafResult } from '../../operations/checkpoint.js';
import { modelOutputSchema } from '../../model/interactions.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import { modelOutputRejected } from '../../model/rejection.js';
import { AttemptDefinition, checkpointPoint, cloneCheckpointValue, type CheckpointValue, type CheckpointCodec, type InvocationCheckpointPoint, type InvocationCheckpointDefinition, type AttemptWork, RuntimeError, isNonBlankString } from '@capix/server-runtime';

import type { ModelOutput } from '../../model/types.js';
import type { ModelOutputContract } from '../../model/contract.js';

export interface ModelAcceptanceInput {
  readonly output: ModelOutput;
}

export class AcceptModelOutputDefinition<Input extends ModelAcceptanceInput, Output> extends AttemptDefinition<Input, Output> {
  readonly checkpoint: InvocationCheckpointDefinition<Input, Output, 'attempt'>;
  private readonly resultPoint: InvocationCheckpointPoint<Input, Output, 'attempt', Output, Record<string, never>, {}, never>;
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
    const output: CheckpointCodec<Output> = { encode: cloneCheckpointValue, decode: (value: CheckpointValue) => cloneCheckpointValue(value) as Output };
    this.resultPoint = checkpointPoint<'attempt', Input, Output>()({
      name: 'result',
      state: output,
      references: {},
      check: (result, facts) => {
        checkLeafResult(facts);
        const basis = facts.input;
        checkCompletion(basis.output);
        if (!isEqual(this.contract.accept(parseContent(basis.output.content), basis), result)) throw new Error('Accepted model checkpoint differs from declared output');
      },
      resume: { requires: {}, execute: (_work, result) => result },
    });
    this.checkpoint = { key: 'observer.accept-model-output', version: 1, input, output, points: [this.resultPoint] };
  }

  private execute(work: AttemptWork<Input, Output>): Output {
    checkCompletion(work.input.output);
    try {
      const value = parseContent(work.input.output.content);
      const output = this.contract.accept(value, work.input);
      work.checkpoint?.save(this.resultPoint, output, {});
      return output;
    } catch (error) {
      if (error instanceof RuntimeError && (error.code === 'INVALID_JSON' || error.code === 'EMPTY_OUTPUT' || error.code === 'OUTPUT_SHAPE')) {
        throw modelOutputRejected.create(error.message, { code: error.code, output: work.input.output }, { cause: error });
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
