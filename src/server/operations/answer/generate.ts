import { sortBy } from 'es-toolkit/array';
import type { ModelRequest, Selection } from '../../../shared/types.js';
import type { ExecutionContext } from '../../context/execution.js';
import { checkCapacity, estimateCapacity } from '../../model/capacity.js';
import type { GenerationOutput } from '../../../shared/operations/generation.js';
import { answerOutputContract } from './output.js';
import { AssembleContext, type AssembledContext } from '../../attempt/context/assemble.js';
import { Operation } from '../operation.js';
import { PrepareModelRequest } from '../../attempt/model/prepare.js';
import { InvokeModel } from '../../attempt/model/invoke.js';
import { AcceptModelOutput } from '../../attempt/model/accept.js';
import type { Runtime } from '../../runtime/runtime.js';
import type { ModelProvider } from '../../provider.js';
import type { OperationContext } from '../../context/operation.js';
import { loadRequest } from '../../model/request.js';
import type { Memory } from '../../memory/memory.js';

export interface GenerationInput {
  readonly selection: Selection;
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

export class GenerateAnswer extends Operation<GenerationInput, GenerationOutput> {
  readonly name = 'answer';
  readonly label = '生成回答';
  readonly source = 'src/server/operations/answer/generate.ts · GenerateAnswer';
  protected readonly purpose = 'answer';
  protected readonly output = answerOutputContract;
  protected readonly task = `结合当前 message、所选 history 和已有 memories，用中文直接完成用户本次请求。history 是当前消息段的部分原文；memories 是可用于延续交流的已有理解，旧段原文可能不可见。依据足够时正常回答，缺失的细节不要补造。
按信息的对象、适用条件和时效判断依据，当前明确的补充与纠正优先；记忆和助手先前的回答都不自动成为已验证事实。保留尚未消解的冲突与不确定性，不把建议当作确认、局部条件当作普遍偏好。
kind 表达本次回答的性质：answer 为能够回答；needs-info 为缺少用户可补充的必要信息，content 给出具体澄清问题；unknown 为缺乏知识或实际能力，content 如实说明。content 是直接呈现给用户的正文。当前服务没有联网检索、实时数据或工具执行能力，不声称已完成外部操作。`;

  readonly assemble: AssembleContext;
  readonly prepareRequest: PrepareModelRequest<AssembledContext & { memories: GenerationInput['memories'] }>;
  readonly invokeModel: InvokeModel;
  readonly acceptOutput: AcceptModelOutput<GenerationInput, GenerationOutput>;

  constructor(runtime: Runtime, provider: ModelProvider) {
    super(runtime);
    this.assemble = new AssembleContext(runtime);
    this.prepareRequest = new PrepareModelRequest(runtime, (input, execution) => this.createRequest(input, execution));
    this.invokeModel = new InvokeModel(runtime, provider, this.purpose);
    this.acceptOutput = new AcceptModelOutput(runtime, this.output);
  }

  protected async execute(context: OperationContext<GenerationInput, GenerationOutput>): Promise<GenerationOutput> {
    const assembled = await this.assemble.call(context, context.currentInput.selection);
    const request = await this.prepareRequest.call(context, { ...assembled, memories: context.currentInput.memories });
    const output = await this.invokeModel.call(context, request);
    return this.acceptOutput.call(context, output);
  }

  protected createRequest(input: AssembledContext & { memories: GenerationInput['memories'] }, execution: ExecutionContext): ModelRequest {
    const selectedMessages: AssembledContext['selectedMessages'][number][] = [];
    let request = this.loadRequest({ ...input, selectedMessages }, execution);
    checkCapacity(request, execution.settings);

    for (const selected of input.selectedMessages) {
      selectedMessages.push(selected);
      const candidate = this.loadRequest({ ...input, selectedMessages }, execution);
      if (!estimateCapacity(candidate, execution.settings).fits) {
        // Never replace a higher-priority message with smaller, lower-priority ones.
        if (selectedMessages.length === 1) checkCapacity(candidate, execution.settings);
        break;
      }
      request = candidate;
    }
    return request;
  }

  private loadRequest(input: AssembledContext & { memories: GenerationInput['memories'] }, execution: ExecutionContext): ModelRequest {
    return loadRequest(this.prepare(input), this.task, this.output.schema, execution.settings);
  }

  private prepare(input: AssembledContext & { memories: GenerationInput['memories'] }) {
    return { message: input.message, memories: input.memories, history: sortBy(input.selectedMessages, ['index']).map(({ index, message }) => ({ index, ...message })) };
  }
}
