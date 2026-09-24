import type { Selection } from '../../../shared/types.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { Message } from '../../../shared/transcript/message.js';
import { historyMessages } from './input.js';
import { selectionOutputContract } from './output.js';
import { ModelOperation } from '../model.js';
import { SelectionUsage } from './usage.js';

export class SelectHistory extends ModelOperation<Readonly<Message>, Selection> {
  readonly usage = new SelectionUsage();
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'src/server/operations/history/select.ts · SelectHistory';
  protected readonly purpose = 'selection';
  protected readonly output = selectionOutputContract;
  protected readonly task = `你是对话前文选择器，不回答用户问题。根据当前 message，选择理解它所必需的历史，包括指代、澄清问题及原问题、仍有效的约束与修改。独立话题可返回空数组，不仅按关键词匹配。historyIndexes 必须来自 history、不重复，按相关性与必要性从高到低排列。不改写原文。`;

  protected prepare(input: Readonly<Message>, execution: ExecutionContext) {
    return {
      message: input,
      history: historyMessages(execution).map(({ index, message }) => ({ index, role: message.role, content: message.content })),
    };
  }
}
