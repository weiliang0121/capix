import { BehaviorInitializer } from '@capix-observer/runtime';
import { TranscriptResource } from '@capix-observer/runtime';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ObserverResources, type ModelRequestResources, type HistoryResources } from '../../observer/resources.js';
import { checkResourceRequests, Sequence } from '@capix-observer/runtime';
import type { Invocation } from '@capix-observer/runtime';
import type { ModelSettings } from '@capix-observer/protocol';
import type { Selection } from '../../model/types.js';
import { Operation, type Runtime, type OperationContext, type TranscriptRangeReader } from '@capix-observer/runtime';
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

export class SelectHistory extends Operation<SelectionInput, Selection, ObserverResources> {
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'services/observer/src/operations/history/select.ts · SelectHistory';
  protected readonly purpose = 'selection';
  protected readonly output = selectionOutputContract;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), timeoutMs: ModelSettingsResource.timeout.request(), model: ModelResource.invoke.request() } as const);
  readonly requires = SelectHistory.requires;
  private readonly composition;

  readonly prepareRequest: BehaviorInitializer<PrepareModelRequest<SelectionInput, ModelRequestResources & HistoryResources>>;
  readonly invokeModel: BehaviorInitializer<InvokeModel>;
  readonly acceptOutput: BehaviorInitializer<AcceptModelOutput<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>>;

  constructor(runtime: Runtime) {
    super(runtime.operationInvocations);
    this.prepareRequest = new BehaviorInitializer(selectionRequestResources, () => new PrepareModelRequest<SelectionInput, ModelRequestResources & HistoryResources>(runtime.attemptInvocations, (input, resources) => loadRequest(selectionPayload(input, historyMessages(resources.history, input.message)), selectionTask, this.output.schema, resources.settings), selectionRequestResources));
    this.invokeModel = new BehaviorInitializer(InvokeModel.requires, () => new InvokeModel(runtime.attemptInvocations, this.purpose));
    this.acceptOutput = new BehaviorInitializer(AcceptModelOutput.requires, () => new AcceptModelOutput(runtime.attemptInvocations, { schema: this.output.schema, accept: (value, input: ModelAcceptanceInput & { basis: SelectionBasis }) => this.output.accept(value, input.basis) }));
    this.composition = new Sequence<SelectionInput, Invocation<SelectionInput, Selection, OperationContext<SelectionInput, Selection, ObserverResources>>>()
      .step('request', { use: this.prepareRequest, input: ({ input }) => input })
      .step('model', { use: this.invokeModel, input: ({ outputs }) => outputs.request })
      .step('acceptance', {
        use: this.acceptOutput,
        input: ({ parent, outputs }) => {
          const range = parent.context.resources.values.history;
          return { output: outputs.model, basis: { start: range.start, end: range.end - 1 } };
        },
      });
    checkResourceRequests(this.requires, this.composition.requests);
  }

  protected async execute(context: OperationContext<SelectionInput, Selection, ObserverResources>, invocation: Invocation<SelectionInput, Selection, OperationContext<SelectionInput, Selection, ObserverResources>>): Promise<Selection> {
    const outputs = await this.composition.run(invocation, context.currentInput);
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
