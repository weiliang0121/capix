import { invocationRecording } from '@capix/server-runtime/recording';
import type { ChildBindings } from '@capix/server-runtime';
import { MemoryResource } from '@capix/server-runtime/content';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ModelCallResources, type MemoryWriteResources } from '../../resources.js';
import type { InvocationWorkView, InvocationCheckpointDefinition, ChildInvocationView, InvocationCheckpointFrame } from '@capix/server-runtime';
import { isEqual } from 'es-toolkit/predicate';
import { memoryCheckpointInput, memoryCheckpointOutput } from './checkpoint.js';
import { originalCheckpoint, waitingChild, acceptedChild, childWaitingCodec } from '../checkpoint.js';
import type { ModelRequest, ModelOutput } from '../../model/types.js';
import { modelOutputSchema } from '../../model/interactions.js';
import { OperationDefinition, type OperationContextView } from '@capix/server-runtime';
import { PrepareModelRequestDefinition } from '../../attempt/model/prepare.js';
import { RequestModelDefinition } from '../model/request.js';
import { AcceptModelOutputDefinition, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { ApplyMemoryDefinition } from '../../attempt/memory/apply.js';

import type { MemoryInput } from './input.js';
import { memoryOutputContract, type MemoryExtraction } from './output.js';
import { loadRequest } from '../../model/request.js';

type MemoryContext = OperationContextView<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources>;
type MemoryCall = InvocationWorkView<MemoryInput, MemoryExtraction, MemoryContext>;

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

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), timeoutMs: ModelSettingsResource.timeout.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request(), memoryWriter: MemoryResource.apply.request() } as const);
  readonly run;
  readonly children;
  readonly checkpoint: InvocationCheckpointDefinition<MemoryInput, MemoryExtraction, MemoryContext>;

  readonly prepareRequestDefinition: PrepareModelRequestDefinition<MemoryInput>;
  readonly requestModelDefinition: RequestModelDefinition;
  readonly acceptOutputDefinition: AcceptModelOutputDefinition<ModelAcceptanceInput & { basis: MemoryInput }, MemoryExtraction>;
  readonly applyMemoryDefinition: ApplyMemoryDefinition;

  constructor() {
    super();
    this.prepareRequestDefinition = new PrepareModelRequestDefinition((input, resources) => loadRequest(this.prepare(input), this.task, this.outputContract.schema, resources.settings));
    this.requestModelDefinition = new RequestModelDefinition(this.purpose);
    this.acceptOutputDefinition = new AcceptModelOutputDefinition({ schema: this.outputContract.schema, accept: (value, input: ModelAcceptanceInput & { basis: MemoryInput }) => this.outputContract.accept(value, input.basis) });
    this.applyMemoryDefinition = new ApplyMemoryDefinition();
    this.children = Object.freeze([this.prepareRequestDefinition, this.requestModelDefinition, this.acceptOutputDefinition, this.applyMemoryDefinition]);
    this.checkpoint = {
      key: 'observer.extract-memory',
      version: 1,
      input: memoryCheckpointInput,
      output: memoryCheckpointOutput,
      points: {
        requestWaiting: { state: childWaitingCodec, check: (frame, state) => this.check(frame, state, 'request'), resume: { requires: ExtractMemoryDefinition.requires, uses: this.children, execute: (context, invocation, children, state: { childId: string }) => this.receiveRequest(context, invocation, children, children.get(this.prepareRequestDefinition).resume(invocation, state.childId)) } },
        modelWaiting: { state: childWaitingCodec, check: (frame, state) => this.check(frame, state, 'model'), resume: { requires: ExtractMemoryDefinition.requires, uses: this.children, execute: (context, invocation, children, state: { childId: string }) => this.receiveModel(context, invocation, children, children.get(this.requestModelDefinition).resume(invocation, state.childId)) } },
        acceptanceWaiting: { state: childWaitingCodec, check: (frame, state) => this.check(frame, state, 'acceptance'), resume: { requires: ExtractMemoryDefinition.requires, uses: this.children, execute: (context, invocation, children, state: { childId: string }) => this.receiveAcceptance(invocation, children, children.get(this.acceptOutputDefinition).resume(invocation, state.childId)) } },
        applicationWaiting: { state: childWaitingCodec, check: (frame, state) => this.check(frame, state, 'application'), resume: { requires: ExtractMemoryDefinition.requires, uses: this.children, execute: (_context, invocation, children, state: { childId: string }) => this.receiveApplication(children, children.get(this.applyMemoryDefinition).resume(invocation, state.childId)) } },
      },
    };
    this.run = { requires: ExtractMemoryDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  protected prepare(input: MemoryInput) {
    return { currentIndexes: input.currentIndexes, messages: input.messages.map(({ index, message }) => ({ index, role: message.role, content: message.content })), memories: input.memories, ...(input.results ? { results: input.results } : {}) };
  }

  private async execute(context: MemoryContext, invocation: MemoryCall, children: ChildBindings): Promise<MemoryExtraction> {
    const child = children.get(this.prepareRequestDefinition).create(invocation, context.currentInput, { key: 'request' });
    invocation.checkpoint?.save('requestWaiting', { childId: child.context.id });
    return this.receiveRequest(context, invocation, children, child);
  }

  private async receiveRequest(context: MemoryContext, invocation: MemoryCall, children: ChildBindings, child: ChildInvocationView<MemoryInput, ModelRequest>): Promise<MemoryExtraction> {
    await child.run();
    const request = await children.accept(child, (value) => value);
    const model = children.get(this.requestModelDefinition).create(invocation, request, { key: 'model' });
    invocation.checkpoint?.save('modelWaiting', { childId: model.context.id });
    return this.receiveModel(context, invocation, children, model);
  }

  private async receiveModel(context: MemoryContext, invocation: MemoryCall, children: ChildBindings, child: ChildInvocationView<ModelRequest, ModelOutput>): Promise<MemoryExtraction> {
    await child.run();
    const output = await children.accept(child, (value) => value);
    const acceptance = children.get(this.acceptOutputDefinition).create(invocation, { output, basis: context.currentInput }, { key: 'acceptance' });
    invocation.checkpoint?.save('acceptanceWaiting', { childId: acceptance.context.id });
    return this.receiveAcceptance(invocation, children, acceptance);
  }

  private async receiveAcceptance(invocation: MemoryCall, children: ChildBindings, child: ChildInvocationView<ModelAcceptanceInput & { basis: MemoryInput }, MemoryExtraction>): Promise<MemoryExtraction> {
    await child.run();
    const output = await children.accept(child, (value) => value);
    const application = children.get(this.applyMemoryDefinition).create(invocation, output, { key: 'application' });
    invocation.checkpoint?.save('applicationWaiting', { childId: application.context.id });
    return this.receiveApplication(children, application);
  }

  private async receiveApplication(children: ChildBindings, child: ChildInvocationView<MemoryExtraction, MemoryExtraction>): Promise<MemoryExtraction> {
    await child.run();
    return children.accept(child, (value) => value);
  }

  private check(frame: InvocationCheckpointFrame, state: { childId: string }, key: 'request' | 'model' | 'acceptance' | 'application'): void {
    originalCheckpoint(frame);
    const positions = ['request', 'model', 'acceptance', 'application'];
    const index = positions.indexOf(key);
    const definitions = [this.prepareRequestDefinition, this.requestModelDefinition, this.acceptOutputDefinition, this.applyMemoryDefinition];
    const current = waitingChild(frame, state, key, definitions[index]!.checkpoint);
    if (frame.children.length !== index + 1) throw new Error('Memory extraction checkpoint has an incompatible stage');
    for (let position = 0; position < index; position++) {
      const previous = acceptedChild(frame.children[position]);
      if (previous.key !== positions[position] || !isEqual(previous.state.output, previous.state.reception.output)) throw new Error('Memory extraction checkpoint has incompatible preparation');
    }
    const request = frame.children[0]!;
    if (!isEqual(request.input, frame.currentInput)) throw new Error('Memory extraction request lost its fixed basis');
    if (index > 0 && !isEqual(frame.children[1]!.input, acceptedChild(request).state.reception.output)) throw new Error('Memory model request differs from preparation');
    if (index > 1 && !isEqual(frame.children[2]!.input, { output: acceptedChild(frame.children[1]).state.reception.output, basis: frame.currentInput })) throw new Error('Memory acceptance lost its original basis');
    if (index > 2 && !isEqual(current.input, acceptedChild(frame.children[2]).state.reception.output)) throw new Error('Memory application differs from accepted proposal');
    if (index > 2) {
      const feedback = modelOutputSchema.parse(acceptedChild(frame.children[1]).state.reception.output);
      const basis = memoryCheckpointInput.decode(frame.currentInput);
      if (feedback.finishReason !== 'stop' || !isEqual(memoryOutputContract.accept(JSON.parse(feedback.content), basis), current.input)) throw new Error('Memory application checkpoint does not match its validated model output');
    }
  }
}
