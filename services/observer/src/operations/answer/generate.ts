import { callRecording } from '@capix-observer/runtime';
import { modelOutputRejected } from '../../model/rejection.js';
import type { ChildBindings } from '@capix-observer/runtime';
import { TranscriptResource } from '@capix-observer/runtime';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ObserverResources, type ModelRequestResources } from '../../observer/resources.js';
import { Sequence } from '@capix-observer/runtime';
import type { DeclaredException, InvocationResolution, InvocationView } from '@capix-observer/runtime';
import { sortBy } from 'es-toolkit/array';
import type { ModelRequest, Selection } from '../../model/types.js';
import { OperationDefinition, type OperationScope, type Memory } from '@capix-observer/runtime';
import { checkCapacity, estimateCapacity } from '../../model/capacity.js';
import type { GenerationOutput } from '@capix-observer/protocol';
import { answerOutputContract } from './output.js';
import { AssembleContext, type AssembledContext } from '../../attempt/context/assemble.js';

import { PrepareModelRequest } from '../../attempt/model/prepare.js';
import { InvokeModel } from '../../attempt/model/invoke.js';
import { AcceptModelOutput, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { modelRegenerationInput, prepareRegenerationRequest, type ModelRegenerationInput, type ModelRegenerationEvidence } from '../../model/regeneration.js';

import { loadRequest } from '../../model/request.js';

export interface GenerationInput {
  readonly selection: Selection;
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

export class GenerateAnswer extends OperationDefinition<GenerationInput, GenerationOutput, ObserverResources> {
  readonly observation = [callRecording()];
  readonly name = 'answer';
  readonly label = '生成回答';
  readonly source = 'services/observer/src/operations/answer/generate.ts · GenerateAnswer';
  protected readonly purpose = 'answer';
  protected readonly output = answerOutputContract;
  protected readonly task = `结合当前 message、所选 history 和已有 memories，用中文直接完成用户本次请求。history 是当前消息段的部分原文；memories 是可用于延续交流的已有理解，旧段原文可能不可见。依据足够时正常回答，缺失的细节不要补造。
按信息的对象、适用条件和时效判断依据，当前明确的补充与纠正优先；记忆和助手先前的回答都不自动成为已验证事实。保留尚未消解的冲突与不确定性，不把建议当作确认、局部条件当作普遍偏好。
kind 表达本次回答的性质：answer 为能够回答；needs-info 为缺少用户可补充的必要信息，content 给出具体澄清问题；unknown 为缺乏知识或实际能力，content 如实说明。content 是直接呈现给用户的正文。当前服务没有联网检索、实时数据或工具执行能力，不声称已完成外部操作。`;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), timeoutMs: ModelSettingsResource.timeout.request(), model: ModelResource.invoke.request() } as const);
  readonly run;
  override readonly maxRounds = 2;
  readonly exceptions = {
    requires: {},
    accepts: [modelOutputRejected],
    handle: this.handleException.bind(this),
  };
  readonly children;
  private readonly composition;
  private readonly regenerationComposition;
  readonly prepareRegeneration: PrepareModelRequest<ModelRegenerationInput>;

  readonly assemble: AssembleContext;
  readonly prepareRequest: PrepareModelRequest<AssembledContext & { memories: GenerationInput['memories'] }>;
  readonly invokeModel: InvokeModel;
  readonly acceptOutput: AcceptModelOutput<ModelAcceptanceInput, GenerationOutput>;

  constructor() {
    super();
    this.assemble = new AssembleContext();
    this.prepareRequest = new PrepareModelRequest((input, resources) => this.createRequest(input, resources));
    this.invokeModel = new InvokeModel(this.purpose);
    this.acceptOutput = new AcceptModelOutput(this.output);
    this.composition = new Sequence<GenerationInput, InvocationView<unknown, unknown, OperationScope>>()
      .step('context', { use: this.assemble, input: ({ input }) => input.selection })
      .step('request', { use: this.prepareRequest, input: ({ input, outputs }) => ({ ...outputs.context, memories: input.memories }) })
      .step('model', { use: this.invokeModel, input: ({ outputs }) => outputs.request })
      .step('acceptance', { use: this.acceptOutput, input: ({ outputs }) => ({ output: outputs.model }) });
    this.prepareRegeneration = new PrepareModelRequest(prepareRegenerationRequest);
    this.regenerationComposition = new Sequence<ModelRegenerationEvidence, InvocationView<unknown, unknown, OperationScope>>()
      .step('request', { use: this.prepareRegeneration, input: ({ parent, input }) => modelRegenerationInput(parent, input) })
      .step('model', { use: this.invokeModel.regeneration.entry, input: ({ input, outputs }) => ({ request: outputs.request, evidence: input }) })
      .step('acceptance', { use: this.acceptOutput, input: ({ outputs }) => ({ output: outputs.model }) });
    this.children = Object.freeze([this.prepareRegeneration, this.assemble, this.prepareRequest, this.invokeModel, this.acceptOutput]);
    this.run = { requires: GenerateAnswer.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationScope<GenerationInput, GenerationOutput, ObserverResources>, invocation: InvocationView<GenerationInput, GenerationOutput, OperationScope<GenerationInput, GenerationOutput, ObserverResources>>, children: ChildBindings): Promise<GenerationOutput> {
    if (context.progress.round === 1) return (await this.composition.run(invocation, context.currentInput, children)).acceptance;
    const evidence = this.regenerationEvidence(invocation);
    if (!evidence) throw new Error('Missing model regeneration evidence');
    return (await this.regenerationComposition.run(invocation, evidence, children)).acceptance;
  }

  private handleException(context: OperationScope<GenerationInput, GenerationOutput, Record<string, never>>, exception: DeclaredException, invocation: InvocationView<GenerationInput, GenerationOutput, OperationScope<GenerationInput, GenerationOutput, Record<string, never>>>): InvocationResolution<GenerationInput, GenerationOutput> {
    if (context.progress.round === 1) {
      const evidence = this.regenerationEvidence(invocation);
      if (evidence?.rejection.returned?.status === 'failed' && evidence.rejection.returned.error === exception && this.invokeModel.regeneration.allows(invocation, evidence)) {
        return { kind: 'continue', input: context.currentInput, reason: '完整模型返回未通过输出契约检查，按能力声明携带错误反馈再生成一次。' };
      }
    }
    return { kind: 'unhandled' };
  }

  private regenerationEvidence(invocation: InvocationView<GenerationInput, GenerationOutput, OperationScope<GenerationInput, GenerationOutput>>): ModelRegenerationEvidence | undefined {
    const children = invocation.children.values().filter((child) => child.round === 1);
    const previous = children.find((child) => child.key === 'model');
    const rejection = children.find((child) => child.key === 'acceptance');
    return previous && rejection ? { previous, rejection } : undefined;
  }

  protected createRequest(input: AssembledContext & { memories: GenerationInput['memories'] }, resources: ModelRequestResources): ModelRequest {
    const selectedMessages: AssembledContext['selectedMessages'][number][] = [];
    let request = this.loadRequest({ ...input, selectedMessages }, resources);
    checkCapacity(request, resources.settings);

    for (const selected of input.selectedMessages) {
      selectedMessages.push(selected);
      const candidate = this.loadRequest({ ...input, selectedMessages }, resources);
      if (!estimateCapacity(candidate, resources.settings).fits) {
        // Never replace a higher-priority message with smaller, lower-priority ones.
        if (selectedMessages.length === 1) checkCapacity(candidate, resources.settings);
        break;
      }
      request = candidate;
    }
    return request;
  }

  private loadRequest(input: AssembledContext & { memories: GenerationInput['memories'] }, resources: ModelRequestResources): ModelRequest {
    return loadRequest(this.prepare(input), this.task, this.output.schema, resources.settings);
  }

  private prepare(input: AssembledContext & { memories: GenerationInput['memories'] }) {
    return { message: input.message, memories: input.memories, history: sortBy(input.selectedMessages, ['index']).map(({ index, message }) => ({ index, ...message })) };
  }
}
