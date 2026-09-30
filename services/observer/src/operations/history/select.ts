import { Sequence } from '@capix-observer/runtime';
import type { Invocation } from '@capix-observer/runtime';
import type { ModelSettings } from '@capix-observer/protocol';
import type { Selection } from '../../model/types.js';
import { type ExecutionContext, Operation, type Runtime, type OperationContext, type TranscriptRangeRef } from '@capix-observer/runtime';
import { historyMessages, type SelectionInput } from './input.js';
import { selectionOutputContract } from './output.js';

import { PrepareModelRequest } from '../../attempt/model/prepare.js';
import { InvokeModel } from '../../attempt/model/invoke.js';
import { AcceptModelOutput } from '../../attempt/model/accept.js';

import type { ModelProvider } from '../../provider.js';

import { loadRequest } from '../../model/request.js';
import { estimateCapacity } from '../../model/capacity.js';

export class SelectHistory extends Operation<SelectionInput, Selection> {
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'services/observer/src/operations/history/select.ts · SelectHistory';
  protected readonly purpose = 'selection';
  protected readonly output = selectionOutputContract;
  protected readonly task = `结合 memories 中的已有理解和 history 中的可见原文，为回答当前 message 选择充分且相关的历史依据。关注指代、仍有效的条件，以及能补充或修正已有理解的信息；由你判断需要哪些原文，不只按关键词匹配。
history 仅覆盖当前消息段，memories 可能保留旧段理解，但不保证正确，也不代表其来源原文可见。historyIndexes 只能选自 history，按相关性与必要性从高到低排列，不重复；无需原文时返回空数组。不生成回答。`;

  private readonly composition;

  readonly prepareRequest: PrepareModelRequest<SelectionInput>;
  readonly invokeModel: InvokeModel;
  readonly acceptOutput: AcceptModelOutput<SelectionInput, Selection>;

  constructor(runtime: Runtime, provider: ModelProvider) {
    super(runtime.operationInvocations);
    this.prepareRequest = new PrepareModelRequest(runtime.attemptInvocations, (input, execution) => loadRequest(this.prepare(input, execution), this.task, this.output.schema, execution.settings));
    this.invokeModel = new InvokeModel(runtime.attemptInvocations, provider, this.purpose);
    this.acceptOutput = new AcceptModelOutput(runtime.attemptInvocations, this.output);
    this.composition = new Sequence<SelectionInput, Invocation<unknown, unknown, OperationContext>>()
      .step('request', { use: this.prepareRequest, input: ({ input }) => input })
      .step('model', { use: this.invokeModel, input: ({ outputs }) => outputs.request })
      .step('acceptance', { use: this.acceptOutput, input: ({ outputs }) => outputs.model });
  }

  protected async execute(context: OperationContext<SelectionInput, Selection>, invocation: Invocation<SelectionInput, Selection, OperationContext<SelectionInput, Selection>>): Promise<Selection> {
    const outputs = await this.composition.run(invocation, context.currentInput);
    return outputs.acceptance;
  }

  /** Uses the same payload, prompt and schema as the real selection request. */
  capacity(input: SelectionInput, range: TranscriptRangeRef, settings: ModelSettings) {
    const history = range
      .refs()
      .slice(0, -1)
      .map((ref) => ({ index: ref.index, message: ref.read() }));
    return estimateCapacity(loadRequest(this.payload(input, history), this.task, this.output.schema, settings), settings);
  }

  protected prepare(input: SelectionInput, execution: ExecutionContext) {
    return this.payload(input, historyMessages(execution));
  }

  private payload(input: SelectionInput, history: ReturnType<typeof historyMessages>) {
    return {
      message: input.message,
      memories: input.memories,
      history: history.map(({ index, message }) => ({ index, role: message.role, content: message.content })),
    };
  }
}
