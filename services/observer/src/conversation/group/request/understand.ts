import { isEqual } from 'es-toolkit/predicate';
import { cloneCheckpointValue } from '@capix/server-runtime';
import { understandingInputCodec, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { Group, checkpointPoint, childReference, type GroupWork, type ChildCall } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources, ModelRequestResources } from '../../resources.js';
import type { ModelRequest } from '../../model/types.js';
import { loadRequest } from '../../model/request.js';
import { checkCapacity } from '../../model/capacity.js';
import { PrepareModelRequest } from '../../node/model/prepare.js';
import { RequestModel } from '../model/request.js';
import { AcceptModelOutput, type ModelAcceptanceInput } from '../../node/model/accept.js';
import { understandingHistory, type RequestUnderstandingInput } from './input.js';
import { requestOutputContract, type RequestProposal } from './output.js';

const understandingTask = `理解当前用户 message 要求本轮做什么，只提出候选，不回答正文，不执行操作。
capabilities 是服务当前真实可用的能力；available 若存在，是父层本阶段允许选择的能力目录及参数契约，不得依据目录之外的能力提出操作。历史助手回复和 memories 中关于能力的说法不能覆盖它。history 是可见原文，memories 只是辅助理解；既往写入或“继续”不能自动授权再次读取、保存或覆盖文件。
memories 中的 sourceResults 是已接纳的历史文件创建凭据，可辅助识别此前的处理结果，但不保证文件当前仍存在或内容未变；本次文件操作仍须预检及真实执行。
reply：普通问答，不需要本次文件操作。file：当前用户明确要求读文件、把生成内容保存为文件，或明确回应上一轮必要信息澄清；task 保留用户指定的文件路径，可以是工作目录相对路径，也可以是用户提供的配置根内绝对路径，由受控预检确认。instruction 完整表述本次内容处理目标，避免仅重复“继续”或文件名。引用、讨论文件操作本身不等于请求执行。
fileTask 若存在，是用户在专门入口明确指定的完整约束，来源、目标及是否保存都不能更改、删除或自行添加；正文与其冲突时返回 clarify。没有 fileTask 时，只能使用用户本次明确指定或明确承接澄清的路径，不凭空编造默认文件名，不因历史曾有文件任务而重复操作。
仅在用户确实没有给出必要来源路径、保存文件名或处理要求，且当前可用能力无法获得该信息时返回 clarify，question 给出具体问题。不以候选提案自身的缺陷立即向用户澄清：feedback 是父层或预检给出的修正依据，优先重新核对当前 message 和 history 中已提供的信息，不重复询问已有文件名；不要自行发明输出路径。只要求读取或翻译时不要附加保存；明确保存但没有文件名时才询问保存名称。需要未启用能力时返回 unsupported，explanation 如实说明。文件能力只支持有限 UTF-8 文本读取和创建新文件；不覆盖、删除、遍历目录，不上传下载，不联网。
本次还没有读取任何文件。progress 只描述父层已接纳的事实，预检通过并不意味着已读取正文或已保存。不得假装知道文件内容、检查存在性或已创建文件；文件操作将在父层接纳之后进行。`;

const requestResources = Object.freeze({ settings: ModelSettingsResource.snapshot.request() });

export class UnderstandRequest extends Group<RequestUnderstandingInput, RequestProposal, ModelCallResources> {
  static readonly requires = Object.freeze({ ...requestResources, timeoutMs: ModelSettingsResource.timeout.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() });

  readonly points;
  private readonly filesEnabled: boolean;
  readonly prepareRequest: PrepareModelRequest<RequestUnderstandingInput, ModelRequestResources>;
  readonly requestModel;
  readonly acceptOutput;

  constructor(options: { readonly files: boolean }) {
    super();

    this.requestModel = new RequestModel('understanding');
    this.acceptOutput = new AcceptModelOutput<ModelAcceptanceInput, RequestProposal>(requestOutputContract);
    this.filesEnabled = options.files;
    this.prepareRequest = new PrepareModelRequest((input, resources) => this.createRequest(input, resources), requestResources);
    this.add(this.prepareRequest, this.requestModel, this.acceptOutput);
    const proposalCodec = { encode: (value: RequestProposal) => cloneCheckpointValue(requestOutputContract.accept(value)), decode: (value: unknown) => requestOutputContract.accept(value) };
    const point = checkpointPoint<'group', RequestUnderstandingInput, RequestProposal>();
    this.points = {
      requestWaiting: point({
        name: 'requestWaiting',
        state: emptyCheckpointState,
        references: { child: childReference(this.prepareRequest) },
        check: (_state, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'request');
          if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input)) throw new Error('Understanding preparation checkpoint changed input');
        },
        resume: { uses: this.members, execute: (work, _state, saved) => this.receiveRequest(work, work.children.resume(saved.child)) },
      }),
      acceptanceWaiting: point({
        name: 'acceptanceWaiting',
        state: emptyCheckpointState,
        references: { child: childReference(this.acceptOutput) },
        check: (_state, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'acceptance');
          const model = acceptedChild(facts.children.requireUnique(this.requestModel, { parentRound: 1 }));
          if (facts.children.values().length !== 3 || model.key !== 'model' || !isEqual(child.input, { output: model.reception.value })) throw new Error('Understanding acceptance checkpoint changed feedback');
        },
        resume: { uses: [this.acceptOutput], execute: (work, _state, saved) => this.receiveAcceptance(work, work.children.resume(saved.child)) },
      }),
      modelWaiting: point({
        name: 'modelWaiting',
        state: emptyCheckpointState,
        references: { child: childReference(this.requestModel) },
        check: (_state, facts) => {
          originalCheckpoint(facts);
          const model = waitingChild(facts, facts.references.child, 'model');
          const request = acceptedChild(facts.children.requireUnique(this.prepareRequest, { parentRound: 1 }));
          if (facts.children.values().length !== 2 || request.key !== 'request' || !isEqual(request.input, facts.input) || !isEqual(model.input, request.reception.value)) throw new Error('Understanding checkpoint differs from prepared model request');
        },
        resume: { uses: [this.requestModel, this.acceptOutput], execute: (work, _state, saved) => this.receiveModel(work, work.children.resume(saved.child)) },
      }),
      result: point({
        name: 'result',
        state: proposalCodec,
        references: {},
        check: (output, facts) => {
          originalCheckpoint(facts);
          const child = acceptedChild(facts.children.requireUnique(this.acceptOutput, { parentRound: 1 }));
          if (child.key !== 'acceptance' || !isEqual(child.reception.value, output)) throw new Error('Understanding checkpoint differs from accepted proposal');
        },
        resume: { execute: (_work, output) => output },
      }),
    };

    this.setDefinition({ observation: [invocationRecording()], name: 'understanding', label: '理解请求', source: 'services/observer/src/conversation/group/request/understand.ts · UnderstandRequest', run: { requires: UnderstandRequest.requires, uses: this.members, execute: this.execute.bind(this) }, checkpoint: { key: `observer.understand-request.${options.files ? 'files' : 'chat'}`, version: 3, input: understandingInputCodec, output: proposalCodec, points: Object.values(this.points) } });
  }

  private async execute(work: GroupWork<RequestUnderstandingInput, RequestProposal, object>): Promise<RequestProposal> {
    const request = work.children.create(this.prepareRequest, work.input, { key: 'request' });
    work.checkpoint?.save(this.points.requestWaiting, null, { child: request.ref });
    return this.receiveRequest(work, request);
  }
  private async receiveRequest(work: GroupWork<RequestUnderstandingInput, RequestProposal, object>, request: ChildCall<PrepareModelRequest<RequestUnderstandingInput, ModelRequestResources>>): Promise<RequestProposal> {
    await request.run();
    const prepared = await request.accept();
    const model = work.children.create(this.requestModel, prepared, { key: 'model' });
    work.checkpoint?.save(this.points.modelWaiting, null, { child: model.ref });
    return this.receiveModel(work, model);
  }
  private async receiveModel(work: GroupWork<RequestUnderstandingInput, RequestProposal, object>, model: ChildCall<RequestModel>): Promise<RequestProposal> {
    await model.run();
    const output = await model.accept();
    const acceptance = work.children.create(this.acceptOutput, { output }, { key: 'acceptance' });
    work.checkpoint?.save(this.points.acceptanceWaiting, null, { child: acceptance.ref });
    return this.receiveAcceptance(work, acceptance);
  }
  private async receiveAcceptance(work: GroupWork<RequestUnderstandingInput, RequestProposal, object>, acceptance: ChildCall<AcceptModelOutput<ModelAcceptanceInput, RequestProposal>>): Promise<RequestProposal> {
    await acceptance.run();
    const result = await acceptance.accept();
    work.checkpoint?.save(this.points.result, result, {});
    return result;
  }

  private createRequest(input: RequestUnderstandingInput, resources: ModelRequestResources): ModelRequest {
    const history = understandingHistory(input);
    const filesAvailable = this.filesEnabled && (input.available === undefined || input.available.some((capability) => capability.name === 'checkFile'));
    const payload = { message: input.message, memories: input.memories, ...(input.fileTask ? { fileTask: input.fileTask } : {}), capabilities: { files: filesAvailable ? { readText: true, createText: true, encoding: 'utf-8', overwrite: false } : null }, ...(input.available ? { available: input.available } : {}), ...(input.feedback ? { feedback: input.feedback } : {}), ...(input.progress ? { progress: input.progress } : {}) };
    const request = loadRequest({ ...payload, history }, understandingTask, requestOutputContract.schema, resources.settings);
    checkCapacity(request, resources.settings);
    return request;
  }
}
