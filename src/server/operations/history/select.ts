import type { ModelSettings, Selection } from '../../../shared/types.js';
import type { ExecutionContext } from '../../context/execution.js';
import { historyMessages, type SelectionInput } from './input.js';
import { selectionOutputContract } from './output.js';
import { ModelOperation } from '../model.js';
import { loadRequest } from '../model/request.js';
import { estimateCapacity } from '../model/capacity.js';
import type { TranscriptRangeRef } from '../../transcript/ref.js';
import { SelectionUsage } from './usage.js';

export class SelectHistory extends ModelOperation<SelectionInput, Selection> {
  readonly usage = new SelectionUsage();
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'src/server/operations/history/select.ts · SelectHistory';
  protected readonly purpose = 'selection';
  protected readonly output = selectionOutputContract;
  protected readonly task = `为回答当前 message 选择充分且相关的历史依据。memories 提供已有理解，history 只提供当前消息段的原始交流，旧段可能已退出加载；结合两者，选择能够支持、补充或修正本次理解的原文。
只返回 historyIndexes：来自 history、不重复，按相关性与必要性从高到低排列；无需历史时返回空数组。不回答用户问题。`;

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
