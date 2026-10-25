import { MemoryResource } from '@capix/server-runtime/content';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ModelCallResources, type MemoryWriteResources } from '../../resources.js';
import { checkpointPoint, childReference, type GroupWork, type ChildCall, type CheckpointFacts, type ChildFact } from '@capix/structure';
import { isEqual } from 'es-toolkit/predicate';
import { memoryCheckpointInput, memoryCheckpointOutput } from './checkpoint.js';
import { originalCheckpoint, waitingChild, acceptedChild, emptyCheckpointState } from '../checkpoint.js';
import { modelOutputSchema } from '../../model/interactions.js';
import { Group } from '@capix/structure';
import { PrepareModelRequest } from '../../node/model/prepare.js';
import { RequestModel } from '../model/request.js';
import { AcceptModelOutput, type ModelAcceptanceInput } from '../../node/model/accept.js';

import { ApplyMemory } from '../../node/memory/apply.js';

import type { MemoryInput } from './input.js';
import { memoryOutputContract, type MemoryExtraction } from './output.js';
import { loadRequest } from '../../model/request.js';

type MemoryWork = GroupWork<MemoryInput, MemoryExtraction, object>;

export class ExtractMemory extends Group<MemoryInput, MemoryExtraction, ModelCallResources & MemoryWriteResources> {
  protected readonly purpose: 'memory';
  protected readonly outputContract;
  protected readonly task;

  static readonly deps = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), timeoutMs: ModelSettingsResource.timeout.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request(), memoryWriter: MemoryResource.apply.request() } as const);

  readonly points;

  readonly prepareRequest: PrepareModelRequest<MemoryInput>;
  readonly requestModel: RequestModel;
  readonly acceptOutput: AcceptModelOutput<ModelAcceptanceInput & { basis: MemoryInput }, MemoryExtraction>;
  readonly applyMemory: ApplyMemory;

  constructor() {
    super();

    this.purpose = 'memory';
    this.outputContract = memoryOutputContract;
    this.task = `维护能帮助后续交流的准确理解：结合本轮交流与已有记忆，以能否支持后续理解、判断和继续处理为依据，保留有价值的信息、修正过时认识、保留有效条件与不确定性。根据内容之间的联系决定新建或更新，以及理解的划分、粒度与综合方式；新建和更新没有优先顺序，已有记忆的标题与划分不预设后续信息的归属。
messages 是本次可见原文，currentIndexes 标记本轮输入与回答；其余原文是筛选候选，不保证全部用于回答。memories 是已有理解，不是已验证事实。根据角色与语境区分陈述、建议、推断和确认；助手回答或重复表达不自动构成事实确认，不把临时要求泛化为持续偏好。
只提交本轮有实质变化的记忆，最多四项；无变化返回空 memories。create 建立新记忆，memoryId 为 null；update 使用可见的已有 ID，同批不得重复更新同一 ID。change 说明本次变化，result 给出变更后完整的 topic、content 与 sourceIndexes，不是补丁；更新时保留仍有效的信息，不为表示保留而返回无变化的 update。
每项 sourceIndexes 是本次变化依据，只能来自 messages，且至少包含一个 currentIndexes。result.sourceIndexes 支撑完整正文，必须包含本次变化依据；更新时还可沿用该目标记忆原有的来源索引，创建时只能引用可见原文。继承旧索引不表示本轮读取或验证了旧原文，不能据此补造细节。
如提供 results，它们是本轮已经接纳的实际操作结果。file-created 说明 answerIndex 对应的正式回答已创建到 receipt.path，bytes 与 digest 描述当时写入的内容；这证明历史创建事实，不保证文件当前仍存在或内容未变。预检通过、保存目标和助手声称已保存不构成创建事实。
若记忆采用操作结果，在本次变化的 sourceResultIds 中引用 results 的 ID，并在 result.sourceResultIds 中保留支撑完整正文的 ID；后者必须包含本次变化引用，update 还可沿用该目标记忆 sourceResults 中的 ID，不能借用其他记忆来源。只引用系统提供的 ID，不编造或输出凭据。操作来源不替代消息来源；没有使用时省略 sourceResultIds。按后续理解价值选择是否保留，即使有操作结果，也允许返回空 memories。`;
    this.prepareRequest = new PrepareModelRequest((input, resources) => loadRequest(this.prepare(input), this.task, this.outputContract.schema, resources.settings));
    this.requestModel = new RequestModel(this.purpose);
    this.acceptOutput = new AcceptModelOutput({ schema: this.outputContract.schema, accept: (value, input: ModelAcceptanceInput & { basis: MemoryInput }) => this.outputContract.accept(value, input.basis) });
    this.applyMemory = new ApplyMemory();
    this.add(this.prepareRequest, this.requestModel, this.acceptOutput, this.applyMemory);
    const point = checkpointPoint<'group', MemoryInput, MemoryExtraction>();
    this.points = {
      requestWaiting: point({ name: 'requestWaiting', state: emptyCheckpointState, references: { child: childReference(this.prepareRequest) }, check: (_state, facts) => this.check(facts, facts.references.child, 'request'), resume: { uses: this.members, run: (work, _state, saved) => this.receiveRequest(work, work.children.resume(saved.child)) } }),
      modelWaiting: point({ name: 'modelWaiting', state: emptyCheckpointState, references: { child: childReference(this.requestModel) }, check: (_state, facts) => this.check(facts, facts.references.child, 'model'), resume: { uses: [this.requestModel, this.acceptOutput, this.applyMemory], run: (work, _state, saved) => this.receiveModel(work, work.children.resume(saved.child)) } }),
      acceptanceWaiting: point({ name: 'acceptanceWaiting', state: emptyCheckpointState, references: { child: childReference(this.acceptOutput) }, check: (_state, facts) => this.check(facts, facts.references.child, 'acceptance'), resume: { uses: [this.acceptOutput, this.applyMemory], run: (work, _state, saved) => this.receiveAcceptance(work, work.children.resume(saved.child)) } }),
      applicationWaiting: point({ name: 'applicationWaiting', state: emptyCheckpointState, references: { child: childReference(this.applyMemory) }, check: (_state, facts) => this.check(facts, facts.references.child, 'application'), resume: { uses: [this.applyMemory], run: (work, _state, saved) => this.receiveApplication(work.children.resume(saved.child)) } }),
    };

    this.name = 'memory';
    this.label = '提取记忆体';
    this.source = 'services/observer/src/conversation/group/memory/extract.ts · ExtractMemory';
    this.deps = ExtractMemory.deps;
    this.run = this.execute.bind(this);
    this.checkpoint = { key: 'observer.extract-memory', version: 2, input: memoryCheckpointInput, output: memoryCheckpointOutput, points: Object.values(this.points) };
  }

  protected prepare(input: MemoryInput) {
    return { currentIndexes: input.currentIndexes, messages: input.messages.map(({ index, message }) => ({ index, role: message.role, content: message.content })), memories: input.memories, ...(input.results ? { results: input.results } : {}) };
  }

  private async execute(work: MemoryWork): Promise<MemoryExtraction> {
    const child = work.children.create(this.prepareRequest, work.input, { key: 'request' });
    work.checkpoint?.({ point: this.points.requestWaiting, state: null, refs: { child: child.ref } });
    return this.receiveRequest(work, child);
  }

  private async receiveRequest(work: MemoryWork, child: ChildCall<PrepareModelRequest<MemoryInput>>): Promise<MemoryExtraction> {
    const request = await child.invoke();
    const model = work.children.create(this.requestModel, request, { key: 'model' });
    work.checkpoint?.({ point: this.points.modelWaiting, state: null, refs: { child: model.ref } });
    return this.receiveModel(work, model);
  }

  private async receiveModel(work: MemoryWork, child: ChildCall<RequestModel>): Promise<MemoryExtraction> {
    const output = await child.invoke();
    const acceptance = work.children.create(this.acceptOutput, { output, basis: work.input }, { key: 'acceptance' });
    work.checkpoint?.({ point: this.points.acceptanceWaiting, state: null, refs: { child: acceptance.ref } });
    return this.receiveAcceptance(work, acceptance);
  }

  private async receiveAcceptance(work: MemoryWork, child: ChildCall<AcceptModelOutput<ModelAcceptanceInput & { basis: MemoryInput }, MemoryExtraction>>): Promise<MemoryExtraction> {
    const output = await child.invoke();
    const application = work.children.create(this.applyMemory, output, { key: 'application' });
    work.checkpoint?.({ point: this.points.applicationWaiting, state: null, refs: { child: application.ref } });
    return this.receiveApplication(application);
  }

  private async receiveApplication(child: ChildCall<ApplyMemory>): Promise<MemoryExtraction> {
    return child.invoke();
  }

  private check(facts: CheckpointFacts<MemoryInput>, selected: ChildFact, key: 'request' | 'model' | 'acceptance' | 'application'): void {
    originalCheckpoint(facts);
    const positions = ['request', 'model', 'acceptance', 'application'];
    const index = positions.indexOf(key);
    const definitions = [this.prepareRequest, this.requestModel, this.acceptOutput, this.applyMemory];
    const current = waitingChild(facts, selected, key);
    const children = facts.children.values();
    if (children.length !== index + 1) throw new Error('Memory extraction checkpoint has an incompatible stage');
    for (let position = 0; position <= index; position++) {
      const child = facts.children.require(definitions[position]!, children[position]!.ref);
      if (child.key !== positions[position]) throw new Error('Memory extraction checkpoint changed the direct child declaration');
      if (position < index) {
        const previous = acceptedChild(child);
        if (!isEqual(previous.returned.output, previous.reception.value)) throw new Error('Memory extraction checkpoint has incompatible preparation');
      }
    }
    const request = children[0]!;
    if (!isEqual(request.input, facts.input)) throw new Error('Memory extraction request lost its fixed basis');
    if (index > 0 && !isEqual(children[1]!.input, acceptedChild(request).reception.value)) throw new Error('Memory model request differs from preparation');
    if (index > 1 && !isEqual(children[2]!.input, { output: acceptedChild(children[1]).reception.value, basis: facts.input })) throw new Error('Memory acceptance lost its original basis');
    if (index > 2 && !isEqual(current.input, acceptedChild(children[2]).reception.value)) throw new Error('Memory application differs from accepted proposal');
    if (index > 2) {
      const feedback = modelOutputSchema.parse(acceptedChild(children[1]).reception.value);
      if (feedback.finishReason !== 'stop' || !isEqual(memoryOutputContract.accept(JSON.parse(feedback.content), facts.input), current.input)) throw new Error('Memory application checkpoint does not match its validated model output');
    }
  }
}
