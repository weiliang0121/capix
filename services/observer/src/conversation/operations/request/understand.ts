import { OperationDefinition, Sequence, type ChildBindings, type InvocationView, type OperationContextView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { TranscriptResource } from '@capix/server-runtime/content';
import { sortBy } from 'es-toolkit/array';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ConversationResources, ModelRequestResources, HistoryResources } from '../../resources.js';
import type { ModelRequest } from '../../model/types.js';
import { loadRequest } from '../../model/request.js';
import { checkCapacity, estimateCapacity } from '../../model/capacity.js';
import { PrepareModelRequestDefinition } from '../../attempt/model/prepare.js';
import { InvokeModelDefinition } from '../../attempt/model/invoke.js';
import { AcceptModelOutputDefinition, type ModelAcceptanceInput } from '../../attempt/model/accept.js';
import { understandingHistory, type RequestUnderstandingInput } from './input.js';
import { requestOutputContract, type RequestProposal } from './output.js';

const understandingTask = `理解当前用户 message 要求本轮做什么，只提出候选，不回答正文，不执行操作。
capabilities 是服务当前真实可用的能力；available 若存在，是父层本阶段允许选择的能力目录及参数契约，不得依据目录之外的能力提出操作。历史助手回复和 memories 中关于能力的说法不能覆盖它。history 是可见原文，memories 只是辅助理解；既往写入或“继续”不能自动授权再次读取、保存或覆盖文件。
memories 中的 sourceResults 是已接纳的历史文件创建凭据，可辅助识别此前的处理结果，但不保证文件当前仍存在或内容未变；本次文件操作仍须预检及真实执行。
reply：普通问答，不需要本次文件操作。file：当前用户明确要求读文件、把生成内容保存为文件，或明确回应上一轮必要信息澄清；task 保留用户指定的文件路径，可以是工作目录相对路径，也可以是用户提供的配置根内绝对路径，由受控预检确认。instruction 完整表述本次内容处理目标，避免仅重复“继续”或文件名。引用、讨论文件操作本身不等于请求执行。
fileTask 若存在，是用户在专门入口明确指定的完整约束，来源、目标及是否保存都不能更改、删除或自行添加；正文与其冲突时返回 clarify。没有 fileTask 时，只能使用用户本次明确指定或明确承接澄清的路径，不凭空编造默认文件名，不因历史曾有文件任务而重复操作。
仅在用户确实没有给出必要来源路径、保存文件名或处理要求，且当前可用能力无法获得该信息时返回 clarify，question 给出具体问题。不以候选提案自身的缺陷立即向用户澄清：feedback 是父层或预检给出的修正依据，优先重新核对当前 message 和 history 中已提供的信息，不重复询问已有文件名；不要自行发明输出路径。只要求读取或翻译时不要附加保存；明确保存但没有文件名时才询问保存名称。需要未启用能力时返回 unsupported，explanation 如实说明。文件能力只支持有限 UTF-8 文本读取和创建新文件；不覆盖、删除、遍历目录，不上传下载，不联网。
本次还没有读取任何文件。progress 只描述父层已接纳的事实，预检通过并不意味着已读取正文或已保存。不得假装知道文件内容、检查存在性或已创建文件；文件操作将在父层接纳之后进行。`;

const requestResources = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request() });

export class UnderstandRequestDefinition extends OperationDefinition<RequestUnderstandingInput, RequestProposal, ConversationResources> {
  readonly observation = [invocationRecording()];
  readonly name = 'understanding';
  readonly label = '理解请求';
  readonly source = 'services/observer/src/conversation/operations/request/understand.ts · UnderstandRequestDefinition';
  static readonly requires = Object.freeze({ ...requestResources, timeoutMs: ModelSettingsResource.timeout.request(), model: ModelResource.invoke.request() });
  readonly run;
  readonly children;
  private readonly composition;
  private readonly filesEnabled: boolean;
  readonly prepareRequestDefinition: PrepareModelRequestDefinition<RequestUnderstandingInput, ModelRequestResources & HistoryResources>;
  readonly invokeModelDefinition = new InvokeModelDefinition('understanding');
  readonly acceptOutputDefinition = new AcceptModelOutputDefinition<ModelAcceptanceInput, RequestProposal>(requestOutputContract);

  constructor(options: { readonly files: boolean }) {
    super();
    this.filesEnabled = options.files;
    this.prepareRequestDefinition = new PrepareModelRequestDefinition((input, resources) => this.createRequest(input, resources), requestResources);
    this.children = Object.freeze([this.prepareRequestDefinition, this.invokeModelDefinition, this.acceptOutputDefinition]);
    this.composition = new Sequence<RequestUnderstandingInput, InvocationView<unknown, unknown, OperationContextView>>()
      .step('request', { use: this.prepareRequestDefinition, input: ({ input }) => input })
      .step('model', { use: this.invokeModelDefinition, input: ({ outputs }) => outputs.request })
      .step('acceptance', { use: this.acceptOutputDefinition, input: ({ outputs }) => ({ output: outputs.model }) });
    this.run = { requires: UnderstandRequestDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationContextView<RequestUnderstandingInput, RequestProposal, ConversationResources>, invocation: InvocationView<RequestUnderstandingInput, RequestProposal, OperationContextView<RequestUnderstandingInput, RequestProposal, ConversationResources>>, children: ChildBindings): Promise<RequestProposal> {
    return (await this.composition.run(invocation, context.currentInput, children)).acceptance;
  }

  private createRequest(input: RequestUnderstandingInput, resources: ModelRequestResources & HistoryResources): ModelRequest {
    const candidates = understandingHistory(input, resources.history);
    const history: typeof candidates = [];
    const filesAvailable = this.filesEnabled && (input.available === undefined || input.available.some((capability) => capability.name === 'checkFile'));
    const payload = { message: input.message, memories: input.memories, ...(input.fileTask ? { fileTask: input.fileTask } : {}), capabilities: { files: filesAvailable ? { readText: true, createText: true, encoding: 'utf-8', overwrite: false } : null }, ...(input.available ? { available: input.available } : {}), ...(input.feedback ? { feedback: input.feedback } : {}), ...(input.progress ? { progress: input.progress } : {}) };
    const load = () => loadRequest({ ...payload, history: sortBy(history, ['index']) }, understandingTask, requestOutputContract.schema, resources.settings);
    let request = load();
    checkCapacity(request, resources.settings);
    for (const message of candidates) {
      history.push(message);
      const candidate = load();
      if (!estimateCapacity(candidate, resources.settings).fits) {
        if (history.length <= Math.min(2, resources.history.length - 1)) checkCapacity(candidate, resources.settings);
        break;
      }
      request = candidate;
    }
    return request;
  }
}
