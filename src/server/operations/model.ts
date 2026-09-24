import type { ModelOutput, ModelRequest, Purpose } from '../../shared/types.js';
import { loadRequest } from './model/request.js';
import { checkCapacity } from './model/capacity.js';
import { RuntimeError } from '../errors/error.js';
import { Operation } from './operation.js';
import type { AttemptContext } from '../context/attempt.js';
import type { ExecutionContext } from '../context/execution.js';
import type { Runtime } from '../runtime/runtime.js';
import type { ModelProvider } from '../provider.js';

/** Static output description paired with acceptance against the operation's input. */
export interface ModelOutputContract<I, O> {
  readonly schema: unknown;
  accept(value: unknown, input: I, execution: ExecutionContext): O;
}

/** Common model invocation stages; concrete operations own their purpose and contracts. */
export abstract class ModelOperation<I, O> extends Operation<I, ModelRequest, ModelOutput, O> {
  protected readonly remote = true;
  protected readonly phaseSource: string = 'src/server/operations/model.ts';
  protected abstract readonly purpose: Purpose;
  protected abstract readonly task: string;
  protected abstract readonly output: ModelOutputContract<I, O>;
  protected abstract prepare(input: I, execution: ExecutionContext): unknown;

  constructor(
    runtime: Runtime,
    private readonly provider: ModelProvider,
  ) {
    super(runtime);
  }

  before(input: I, context: AttemptContext<I, ModelRequest>): ModelRequest {
    const execution = this.runtime.getExecutionContext(context);
    const request = this.createRequest(input, execution);
    checkCapacity(request, execution.settings);
    return request;
  }

  protected createRequest(input: I, execution: ExecutionContext): ModelRequest {
    return loadRequest(this.prepare(input, execution), this.task, this.output.schema, execution.settings);
  }

  commit(request: ModelRequest, context: AttemptContext<ModelRequest, ModelOutput>): Promise<ModelOutput> {
    const execution = this.runtime.getExecutionContext(context);
    const { settings, signal } = execution;
    return this.provider.invoke(request, this.purpose, AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]));
  }

  after(input: ModelOutput, context: AttemptContext<ModelOutput, O>): O {
    checkCompletion(input);
    const value = parseContent(input.content);
    const operation = this.runtime.getOperationContext(context);
    const execution = this.runtime.getExecutionContext(context);
    return this.output.accept(value, operation.input as I, execution);
  }
}

function checkCompletion(output: ModelOutput): void {
  if (output.finishReason !== 'stop') throw new RuntimeError('INCOMPLETE_OUTPUT', `模型未正常结束：${output.finishReason}。原始返回保留，未作为完整结果接纳。`);
}

function parseContent(content: string): unknown {
  if (!content.trim()) throw new RuntimeError('EMPTY_OUTPUT', '模型返回了空内容。');
  try {
    return JSON.parse(content);
  } catch {
    throw new RuntimeError('INVALID_JSON', '模型返回不是完整的 JSON；未自动修复或重试。');
  }
}
