import { invocationRecording } from '@capix/server-runtime/recording';
import type { ChildBindings } from '@capix/server-runtime';
import { MemoryResource } from '@capix/server-runtime/content';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ModelCallResources, type MemoryWriteResources } from '../../resources.js';
import { Sequence } from '@capix/server-runtime';
import type { InvocationView } from '@capix/server-runtime';
import { OperationDefinition, type OperationContextView } from '@capix/server-runtime';
import { PrepareModelRequestDefinition } from '../../attempt/model/prepare.js';
import { InvokeModelDefinition } from '../../attempt/model/invoke.js';
import { AcceptModelOutputDefinition, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { ApplyMemoryDefinition } from '../../attempt/memory/apply.js';

import type { MemoryInput } from './input.js';
import { memoryOutputContract, type MemoryExtraction } from './output.js';
import { loadRequest } from '../../model/request.js';

export class ExtractMemoryDefinition extends OperationDefinition<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources> {
  readonly observation = [invocationRecording()];
  readonly name = 'memory';
  readonly label = '提取记忆体';
  readonly source = 'services/observer/src/conversation/operations/memory/extract.ts · ExtractMemoryDefinition';
  protected readonly purpose = 'memory';
  protected readonly outputContract = memoryOutputContract;
  protected readonly task = `维护能帮助后续交流的准确理解：结合本轮交流与已有记忆，以能否支持后续理解、判断和继续处理为依据，保留有价值的信息、修正过时认识、保留有效条件与不确定性。根据内容之间的联系决定新建或更新，以及理解的划分、粒度与综合方式；新建和更新没有优先顺序，已有记忆的标题与划分不预设后续信息的归属。
messages 是本次可见原文，currentIndexes 标记本轮输入与回答；其余原文是筛选候选，不保证全部用于回答。memories 是已有理解，不是已验证事实。根据角色与语境区分陈述、建议、推断和确认；助手回答或重复表达不自动构成事实确认，不把临时要求泛化为持续偏好。
只提交本轮有实质变化的记忆，最多四项；无变化返回空 memories。create 建立新记忆，memoryId 为 null；update 使用可见的已有 ID，同批不得重复更新同一 ID。change 说明本次变化，result 给出变更后完整的 topic、content 与 sourceIndexes，不是补丁；更新时保留仍有效的信息，不为表示保留而返回无变化的 update。
每项 sourceIndexes 是本次变化依据，只能来自 messages，且至少包含一个 currentIndexes。result.sourceIndexes 支撑完整正文，必须包含本次变化依据；更新时还可沿用该目标记忆原有的来源索引，创建时只能引用可见原文。继承旧索引不表示本轮读取或验证了旧原文，不能据此补造细节。
如提供 results，它们是本轮已经接纳的实际操作结果。file-created 说明 answerIndex 对应的正式回答已创建到 receipt.path，bytes 与 digest 描述当时写入的内容；这证明历史创建事实，不保证文件当前仍存在或内容未变。预检通过、保存目标和助手声称已保存不构成创建事实。
若记忆采用操作结果，在本次变化的 sourceResultIds 中引用 results 的 ID，并在 result.sourceResultIds 中保留支撑完整正文的 ID；后者必须包含本次变化引用，update 还可沿用该目标记忆 sourceResults 中的 ID，不能借用其他记忆来源。只引用系统提供的 ID，不编造或输出凭据。操作来源不替代消息来源；没有使用时省略 sourceResultIds。按后续理解价值选择是否保留，即使有操作结果，也允许返回空 memories。`;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), timeoutMs: ModelSettingsResource.timeout.request(), model: ModelResource.invoke.request(), memoryWriter: MemoryResource.apply.request() } as const);
  readonly run;
  readonly children;
  private readonly composition;

  readonly prepareRequestDefinition: PrepareModelRequestDefinition<MemoryInput>;
  readonly invokeModelDefinition: InvokeModelDefinition;
  readonly acceptOutputDefinition: AcceptModelOutputDefinition<ModelAcceptanceInput & { basis: MemoryInput }, MemoryExtraction>;
  readonly applyMemoryDefinition: ApplyMemoryDefinition;

  constructor() {
    super();
    this.prepareRequestDefinition = new PrepareModelRequestDefinition((input, resources) => loadRequest(this.prepare(input), this.task, this.outputContract.schema, resources.settings));
    this.invokeModelDefinition = new InvokeModelDefinition(this.purpose);
    this.acceptOutputDefinition = new AcceptModelOutputDefinition({ schema: this.outputContract.schema, accept: (value, input: ModelAcceptanceInput & { basis: MemoryInput }) => this.outputContract.accept(value, input.basis) });
    this.applyMemoryDefinition = new ApplyMemoryDefinition();
    this.composition = new Sequence<MemoryInput, InvocationView<unknown, unknown, OperationContextView>>()
      .step('request', { use: this.prepareRequestDefinition, input: ({ input }) => input })
      .step('model', { use: this.invokeModelDefinition, input: ({ outputs }) => outputs.request })
      .step('acceptance', { use: this.acceptOutputDefinition, input: ({ input, outputs }) => ({ output: outputs.model, basis: input }) })
      .step('application', { use: this.applyMemoryDefinition, input: ({ outputs }) => outputs.acceptance });
    this.children = Object.freeze([this.prepareRequestDefinition, this.invokeModelDefinition, this.acceptOutputDefinition, this.applyMemoryDefinition]);
    this.run = { requires: ExtractMemoryDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  protected prepare(input: MemoryInput) {
    return { currentIndexes: input.currentIndexes, messages: input.messages.map(({ index, message }) => ({ index, role: message.role, content: message.content })), memories: input.memories, ...(input.results ? { results: input.results } : {}) };
  }

  private async execute(context: OperationContextView<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources>, invocation: InvocationView<MemoryInput, MemoryExtraction, OperationContextView<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources>>, children: ChildBindings): Promise<MemoryExtraction> {
    const outputs = await this.composition.run(invocation, context.currentInput, children);
    return outputs.application;
  }
}
