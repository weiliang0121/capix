import { callRecording } from '@capix-observer/runtime';
import type { ChildBindings } from '@capix-observer/runtime';
import { TranscriptResource } from '@capix-observer/runtime';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ObserverResources, type ModelRequestResources, type HistoryResources } from '../../observer/resources.js';
import { Sequence } from '@capix-observer/runtime';
import type { InvocationView } from '@capix-observer/runtime';
import type { ModelSettings } from '@capix-observer/protocol';
import type { Selection } from '../../model/types.js';
import { OperationDefinition, type OperationScope, type TranscriptRangeReader } from '@capix-observer/runtime';
import { historyMessages, type SelectionInput } from './input.js';
import { selectionOutputContract, type SelectionBasis } from './output.js';

import { PrepareModelRequest } from '../../attempt/model/prepare.js';
import { InvokeModel } from '../../attempt/model/invoke.js';
import { AcceptModelOutput, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { loadRequest } from '../../model/request.js';
import { estimateCapacity } from '../../model/capacity.js';

const selectionTask = `结合 memories 中的已有理解和 history 中的可见原文，为回答当前 message 选择充分且相关的历史依据。关注指代、仍有效的条件，以及能补充或修正已有理解的信息；由你判断需要哪些原文，不只按关键词匹配。
history 仅覆盖当前消息段，memories 可能保留旧段理解，但不保证正确，也不代表其来源原文可见。historyIndexes 只能选自 history，按相关性与必要性从高到低排列，不重复；无需原文时返回空数组。不生成回答。`;

const selectionRequestResources = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request() });

export class SelectHistory extends OperationDefinition<SelectionInput, Selection, ObserverResources> {
  readonly observation = [callRecording()];
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'services/observer/src/operations/history/select.ts · SelectHistory';
  protected readonly purpose = 'selection';
  protected readonly output = selectionOutputContract;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), timeoutMs: ModelSettingsResource.timeout.request(), model: ModelResource.invoke.request() } as const);
  readonly run;
  readonly children;
  private readonly composition;

  readonly prepareRequest: PrepareModelRequest<SelectionInput, ModelRequestResources & HistoryResources>;
  readonly invokeModel: InvokeModel;
  readonly acceptOutput: AcceptModelOutput<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>;

  constructor() {
    super();
    this.prepareRequest = new PrepareModelRequest<SelectionInput, ModelRequestResources & HistoryResources>((input, resources) => loadRequest(selectionPayload(input, historyMessages(resources.history, input.message)), selectionTask, this.output.schema, resources.settings), selectionRequestResources);
    this.invokeModel = new InvokeModel(this.purpose);
    this.acceptOutput = new AcceptModelOutput({ schema: this.output.schema, accept: (value, input: ModelAcceptanceInput & { basis: SelectionBasis }) => this.output.accept(value, input.basis) });
    this.composition = new Sequence<SelectionInput, InvocationView<SelectionInput, Selection, OperationScope<SelectionInput, Selection, ObserverResources>>>()
      .step('request', { use: this.prepareRequest, input: ({ input }) => input })
      .step('model', { use: this.invokeModel, input: ({ outputs }) => outputs.request })
      .step('acceptance', {
        use: this.acceptOutput,
        input: ({ parent, outputs }) => {
          const range = parent.context.resources.values.history;
          return { output: outputs.model, basis: { start: range.start, end: range.end - 1 } };
        },
      });
    this.children = Object.freeze([this.prepareRequest, this.invokeModel, this.acceptOutput]);
    this.run = { requires: SelectHistory.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationScope<SelectionInput, Selection, ObserverResources>, invocation: InvocationView<SelectionInput, Selection, OperationScope<SelectionInput, Selection, ObserverResources>>, children: ChildBindings): Promise<Selection> {
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
