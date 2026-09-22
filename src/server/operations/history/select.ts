import type { Selection } from '../../../shared/types.js';
import type { SelectionInput } from './input.js';
import { selectionOutputContract } from './output.js';
import { createModelOperation, type ModelDependencies } from '../model.js';
import type { NodeDefinition } from '../../node.js';

export const selectHistoryDefinition = {
  name: 'selection',
  label: '选择历史',
  remote: true,
  source: 'src/server/operations/history/select.ts · createSelectHistory',
  phaseSource: 'src/server/operations/model.ts',
} as const satisfies NodeDefinition;

const task = `你是对话前文选择器，不回答用户问题。选择理解当前 query 所必需的历史条目。保留省略、指代、澄清问题及原问题、仍有效的约束和修改关系。切换到独立话题时可以返回空数组。不能仅按关键词相似性选择。索引必须来自本次 history，不能编造或重复。不改写原文。示例 JSON：{"historyIndexes":[0,1]}`;

export function createSelectHistory(dependencies: ModelDependencies) {
  return createModelOperation<SelectionInput, Selection>(
    {
      purpose: 'selection',
      task,
      output: selectionOutputContract,
      prepare: (input) => ({
        query: input.query.read().content,
        history: input.historyRange.refs().map((ref) => ({ index: ref.index, ...ref.read() })),
      }),
    },
    dependencies,
  );
}
