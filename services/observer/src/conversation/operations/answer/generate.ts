import { invocationRecording } from '@capix/server-runtime/recording';
import { modelOutputRejected } from '../../model/rejection.js';
import type { ChildBindings } from '@capix/server-runtime';
import { TranscriptResource } from '@capix/server-runtime/content';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ConversationResources, type ModelRequestResources } from '../../resources.js';
import { Sequence } from '@capix/server-runtime';
import type { DeclaredException, InvocationResolution, InvocationView } from '@capix/server-runtime';
import { sortBy } from 'es-toolkit/array';
import type { ModelRequest, Selection } from '../../model/types.js';
import { OperationDefinition, type OperationContextView } from '@capix/server-runtime';
import { type Memory } from '@capix/server-runtime/content';
import { checkCapacity, estimateCapacity } from '../../model/capacity.js';
import type { GenerationOutput } from '@capix/protocol';
import { answerOutputContract } from './output.js';
import { AssembleAnswerContextDefinition, type AnswerMessageContext } from '../../attempt/context/assemble.js';

import { PrepareModelRequestDefinition } from '../../attempt/model/prepare.js';
import { InvokeModelDefinition } from '../../attempt/model/invoke.js';
import { AcceptModelOutputDefinition, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { modelRegenerationInput, prepareRegenerationRequest, type ModelRegenerationInput, type ModelRegenerationEvidence } from '../../model/regeneration.js';

import { loadRequest } from '../../model/request.js';

export interface GenerationInput {
  readonly selection: Selection;
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

export class GenerateAnswerDefinition extends OperationDefinition<GenerationInput, GenerationOutput, ConversationResources> {
  readonly observation = [invocationRecording()];
  readonly name = 'answer';
  readonly label = '生成回答';
  readonly source = 'services/observer/src/conversation/operations/answer/generate.ts · GenerateAnswerDefinition';
  protected readonly purpose = 'answer';
  protected readonly outputContract = answerOutputContract;
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
  readonly prepareRegenerationDefinition: PrepareModelRequestDefinition<ModelRegenerationInput>;

  readonly assembleContextDefinition: AssembleAnswerContextDefinition;
  readonly prepareRequestDefinition: PrepareModelRequestDefinition<AnswerMessageContext & { memories: GenerationInput['memories'] }>;
  readonly invokeModelDefinition: InvokeModelDefinition;
  readonly acceptOutputDefinition: AcceptModelOutputDefinition<ModelAcceptanceInput, GenerationOutput>;

  constructor() {
    super();
    this.assembleContextDefinition = new AssembleAnswerContextDefinition();
    this.prepareRequestDefinition = new PrepareModelRequestDefinition((input, resources) => this.createRequest(input, resources));
    this.invokeModelDefinition = new InvokeModelDefinition(this.purpose);
    this.acceptOutputDefinition = new AcceptModelOutputDefinition(this.outputContract);
    this.composition = new Sequence<GenerationInput, InvocationView<unknown, unknown, OperationContextView>>()
      .step('context', { use: this.assembleContextDefinition, input: ({ input }) => input.selection })
      .step('request', { use: this.prepareRequestDefinition, input: ({ input, outputs }) => ({ ...outputs.context, memories: input.memories }) })
      .step('model', { use: this.invokeModelDefinition, input: ({ outputs }) => outputs.request })
      .step('acceptance', { use: this.acceptOutputDefinition, input: ({ outputs }) => ({ output: outputs.model }) });
    this.prepareRegenerationDefinition = new PrepareModelRequestDefinition(prepareRegenerationRequest);
    this.regenerationComposition = new Sequence<ModelRegenerationEvidence, InvocationView<unknown, unknown, OperationContextView>>()
      .step('request', { use: this.prepareRegenerationDefinition, input: ({ parent, input }) => modelRegenerationInput(parent, input) })
      .step('model', { use: this.invokeModelDefinition.regeneration.entry, input: ({ input, outputs }) => ({ request: outputs.request, evidence: input }) })
      .step('acceptance', { use: this.acceptOutputDefinition, input: ({ outputs }) => ({ output: outputs.model }) });
    this.children = Object.freeze([this.prepareRegenerationDefinition, this.assembleContextDefinition, this.prepareRequestDefinition, this.invokeModelDefinition, this.acceptOutputDefinition]);
    this.run = { requires: GenerateAnswerDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationContextView<GenerationInput, GenerationOutput, ConversationResources>, invocation: InvocationView<GenerationInput, GenerationOutput, OperationContextView<GenerationInput, GenerationOutput, ConversationResources>>, children: ChildBindings): Promise<GenerationOutput> {
    if (context.progress.round === 1) return (await this.composition.run(invocation, context.currentInput, children)).acceptance;
    const evidence = this.regenerationEvidence(invocation);
    if (!evidence) throw new Error('Missing model regeneration evidence');
    return (await this.regenerationComposition.run(invocation, evidence, children)).acceptance;
  }

  private handleException(context: OperationContextView<GenerationInput, GenerationOutput, Record<string, never>>, exception: DeclaredException, invocation: InvocationView<GenerationInput, GenerationOutput, OperationContextView<GenerationInput, GenerationOutput, Record<string, never>>>): InvocationResolution<GenerationInput, GenerationOutput> {
    if (context.progress.round === 1) {
      const evidence = this.regenerationEvidence(invocation);
      if (evidence?.rejection.returned?.status === 'failed' && evidence.rejection.returned.error === exception && this.invokeModelDefinition.regeneration.allows(invocation, evidence)) {
        return { kind: 'continue', input: context.currentInput, reason: '完整模型返回未通过输出契约检查，按能力声明携带错误反馈再生成一次。' };
      }
    }
    return { kind: 'unhandled' };
  }

  private regenerationEvidence(invocation: InvocationView<GenerationInput, GenerationOutput, OperationContextView<GenerationInput, GenerationOutput>>): ModelRegenerationEvidence | undefined {
    const children = invocation.children.values().filter((child) => child.round === 1);
    const previous = children.find((child) => child.key === 'model');
    const rejection = children.find((child) => child.key === 'acceptance');
    return previous && rejection ? { previous, rejection } : undefined;
  }

  protected createRequest(input: AnswerMessageContext & { memories: GenerationInput['memories'] }, resources: ModelRequestResources): ModelRequest {
    const selectedMessages: AnswerMessageContext['selectedMessages'][number][] = [];
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

  private loadRequest(input: AnswerMessageContext & { memories: GenerationInput['memories'] }, resources: ModelRequestResources): ModelRequest {
    return loadRequest(this.prepare(input), this.task, this.outputContract.schema, resources.settings);
  }

  private prepare(input: AnswerMessageContext & { memories: GenerationInput['memories'] }) {
    return { message: input.message, memories: input.memories, history: sortBy(input.selectedMessages, ['index']).map(({ index, message }) => ({ index, ...message })) };
  }
}
