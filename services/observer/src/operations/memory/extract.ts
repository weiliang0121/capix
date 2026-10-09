import { callRecording } from '@capix-observer/runtime';
import type { ChildBindings } from '@capix-observer/runtime';
import { MemoryResource } from '@capix-observer/runtime';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ModelCallResources, type MemoryWriteResources } from '../../observer/resources.js';
import { Sequence } from '@capix-observer/runtime';
import type { InvocationView } from '@capix-observer/runtime';
import { OperationDefinition, type OperationScope } from '@capix-observer/runtime';
import { PrepareModelRequest } from '../../attempt/model/prepare.js';
import { InvokeModel } from '../../attempt/model/invoke.js';
import { AcceptModelOutput, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { ApplyMemory } from '../../attempt/memory/apply.js';

import type { MemoryInput } from './input.js';
import { memoryOutputContract, type MemoryExtraction } from './output.js';
import { loadRequest } from '../../model/request.js';

export class ExtractMemory extends OperationDefinition<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources> {
  readonly observation = [callRecording()];
  readonly name = 'memory';
  readonly label = '提取记忆体';
  readonly source = 'services/observer/src/operations/memory/extract.ts · ExtractMemory';
  protected readonly purpose = 'memory';
  protected readonly output = memoryOutputContract;
  protected readonly task = `维护能帮助后续交流的准确理解：结合本轮交流与已有记忆，以能否支持后续理解、判断和继续处理为依据，保留有价值的信息、修正过时认识、保留有效条件与不确定性。根据内容之间的联系决定新建或更新，以及理解的划分、粒度与综合方式；新建和更新没有优先顺序，已有记忆的标题与划分不预设后续信息的归属。
messages 是本次可见原文，currentIndexes 标记本轮输入与回答；其余原文是筛选候选，不保证全部用于回答。memories 是已有理解，不是已验证事实。根据角色与语境区分陈述、建议、推断和确认；助手回答或重复表达不自动构成事实确认，不把临时要求泛化为持续偏好。
只提交本轮有实质变化的记忆，最多四项；无变化返回空 memories。create 建立新记忆，memoryId 为 null；update 使用可见的已有 ID，同批不得重复更新同一 ID。change 说明本次变化，result 给出变更后完整的 topic、content 与 sourceIndexes，不是补丁；更新时保留仍有效的信息，不为表示保留而返回无变化的 update。
每项 sourceIndexes 是本次变化依据，只能来自 messages，且至少包含一个 currentIndexes。result.sourceIndexes 支撑完整正文，必须包含本次变化依据；更新时还可沿用该目标记忆原有的来源索引，创建时只能引用可见原文。继承旧索引不表示本轮读取或验证了旧原文，不能据此补造细节。`;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), timeoutMs: ModelSettingsResource.timeout.request(), model: ModelResource.invoke.request(), memoryWriter: MemoryResource.apply.request() } as const);
  readonly run;
  readonly children;
  private readonly composition;

  readonly prepareRequest: PrepareModelRequest<MemoryInput>;
  readonly invokeModel: InvokeModel;
  readonly acceptOutput: AcceptModelOutput<ModelAcceptanceInput & { basis: MemoryInput }, MemoryExtraction>;
  readonly applyMemory: ApplyMemory;

  constructor() {
    super();
    this.prepareRequest = new PrepareModelRequest((input, resources) => loadRequest(this.prepare(input), this.task, this.output.schema, resources.settings));
    this.invokeModel = new InvokeModel(this.purpose);
    this.acceptOutput = new AcceptModelOutput({ schema: this.output.schema, accept: (value, input: ModelAcceptanceInput & { basis: MemoryInput }) => this.output.accept(value, input.basis) });
    this.applyMemory = new ApplyMemory();
    this.composition = new Sequence<MemoryInput, InvocationView<unknown, unknown, OperationScope>>()
      .step('request', { use: this.prepareRequest, input: ({ input }) => input })
      .step('model', { use: this.invokeModel, input: ({ outputs }) => outputs.request })
      .step('acceptance', { use: this.acceptOutput, input: ({ input, outputs }) => ({ output: outputs.model, basis: input }) })
      .step('application', { use: this.applyMemory, input: ({ outputs }) => outputs.acceptance });
    this.children = Object.freeze([this.prepareRequest, this.invokeModel, this.acceptOutput, this.applyMemory]);
    this.run = { requires: ExtractMemory.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  protected prepare(input: MemoryInput) {
    return { currentIndexes: input.currentIndexes, messages: input.messages.map(({ index, message }) => ({ index, role: message.role, content: message.content })), memories: input.memories };
  }

  private async execute(context: OperationScope<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources>, invocation: InvocationView<MemoryInput, MemoryExtraction, OperationScope<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources>>, children: ChildBindings): Promise<MemoryExtraction> {
    const outputs = await this.composition.run(invocation, context.currentInput, children);
    return outputs.application;
  }
}
