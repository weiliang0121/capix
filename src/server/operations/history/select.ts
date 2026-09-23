import type { Selection } from '../../../shared/types.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { Message } from '../../../shared/transcript/message.js';
import { historyMessages } from './input.js';
import { selectionOutputContract } from './output.js';
import { ModelOperation } from '../model.js';

export class SelectHistory extends ModelOperation<Readonly<Message>, Selection> {
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'src/server/operations/history/select.ts · SelectHistory';
  protected readonly purpose = 'selection';
  protected readonly output = selectionOutputContract;
  protected readonly task = `你是对话前文选择器，不回答用户问题。选择理解当前 message 所必需的历史条目。保留省略、指代、澄清问题及原问题、仍有效的约束和修改关系。切换到独立话题时可以返回空数组。不能仅按关键词相似性选择。索引必须来自本次 history，不能编造或重复。不改写原文。示例 JSON：{"historyIndexes":[0,1]}`;

  protected prepare(input: Readonly<Message>, execution: ExecutionContext) {
    return {
      message: input,
      history: historyMessages(execution).map(({ index, message }) => ({ index, ...message })),
    };
  }
}
