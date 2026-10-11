import { invocationRecording } from '@capix/server-runtime/recording';
import type { ChildBindings } from '@capix/server-runtime';
import { TranscriptResource } from '@capix/server-runtime/content';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ConversationResources, type ModelRequestResources, type HistoryResources } from '../../resources.js';
import { Sequence } from '@capix/server-runtime';
import type { InvocationView } from '@capix/server-runtime';
import type { ModelSettings } from '@capix/protocol';
import type { Selection } from '../../model/types.js';
import { OperationDefinition, type OperationContextView } from '@capix/server-runtime';
import { type TranscriptRangeReader } from '@capix/server-runtime/content';
import { historyMessages, type SelectionInput } from './input.js';
import { selectionOutputContract, type SelectionBasis } from './output.js';

import { PrepareModelRequestDefinition } from '../../attempt/model/prepare.js';
import { InvokeModelDefinition } from '../../attempt/model/invoke.js';
import { AcceptModelOutputDefinition, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { loadRequest } from '../../model/request.js';
import { estimateCapacity } from '../../model/capacity.js';

const selectionTask = `结合 memories 中的已有理解和 history 中的可见原文，为回答当前 message 选择充分且相关的历史依据。关注指代、仍有效的条件，以及能补充或修正已有理解的信息；由你判断需要哪些原文，不只按关键词匹配。
history 仅覆盖当前消息段，memories 可能保留旧段理解，但不保证正确，也不代表其来源原文可见。sourceResults 中的 file-created 是系统接纳的历史创建凭据，不保证文件当前仍存在或正文未变。historyIndexes 只能选自 history，按相关性与必要性从高到低排列，不重复；无需原文时返回空数组。不生成回答。`;

const selectionRequestResources = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request() });

export class SelectHistoryDefinition extends OperationDefinition<SelectionInput, Selection, ConversationResources> {
  readonly observation = [invocationRecording()];
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'services/observer/src/conversation/operations/history/select.ts · SelectHistoryDefinition';
  protected readonly purpose = 'selection';
  protected readonly outputContract = selectionOutputContract;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), timeoutMs: ModelSettingsResource.timeout.request(), model: ModelResource.invoke.request() } as const);
  readonly run;
  readonly children;
  private readonly composition;

  readonly prepareRequestDefinition: PrepareModelRequestDefinition<SelectionInput, ModelRequestResources & HistoryResources>;
  readonly invokeModelDefinition: InvokeModelDefinition;
  readonly acceptOutputDefinition: AcceptModelOutputDefinition<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>;

  constructor() {
    super();
    this.prepareRequestDefinition = new PrepareModelRequestDefinition<SelectionInput, ModelRequestResources & HistoryResources>((input, resources) => loadRequest(selectionPayload(input, historyMessages(resources.history, input.message)), selectionTask, this.outputContract.schema, resources.settings), selectionRequestResources);
    this.invokeModelDefinition = new InvokeModelDefinition(this.purpose);
    this.acceptOutputDefinition = new AcceptModelOutputDefinition({ schema: this.outputContract.schema, accept: (value, input: ModelAcceptanceInput & { basis: SelectionBasis }) => this.outputContract.accept(value, input.basis) });
    this.composition = new Sequence<SelectionInput, InvocationView<SelectionInput, Selection, OperationContextView<SelectionInput, Selection, ConversationResources>>>()
      .step('request', { use: this.prepareRequestDefinition, input: ({ input }) => input })
      .step('model', { use: this.invokeModelDefinition, input: ({ outputs }) => outputs.request })
      .step('acceptance', {
        use: this.acceptOutputDefinition,
        input: ({ parent, outputs }) => {
          const range = parent.context.resources.values.history;
          return { output: outputs.model, basis: { start: range.start, end: range.end - 1 } };
        },
      });
    this.children = Object.freeze([this.prepareRequestDefinition, this.invokeModelDefinition, this.acceptOutputDefinition]);
    this.run = { requires: SelectHistoryDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationContextView<SelectionInput, Selection, ConversationResources>, invocation: InvocationView<SelectionInput, Selection, OperationContextView<SelectionInput, Selection, ConversationResources>>, children: ChildBindings): Promise<Selection> {
    const outputs = await this.composition.run(invocation, context.currentInput, children);
    return outputs.acceptance;
  }
}

/** Capacity preparation shares the request definition without initializing a selection behavior. */
export function selectionCapacity(input: SelectionInput, range: TranscriptRangeReader, settings: ModelSettings) {
  return estimateCapacity(loadRequest(selectionPayload(input, range.entries().slice(0, -1)), selectionTask, selectionOutputContract.schema, settings), settings);
}

function selectionPayload(input: SelectionInput, history: ReturnType<typeof historyMessages>) {
  return { message: input.message, memories: input.memories, history: history.map(({ index, message }) => ({ index, role: message.role, content: message.content })) };
}
