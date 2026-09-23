import type { GenerationOutput } from '../../../shared/operations/generation.js';
import { answerOutputContract } from './output.js';
import type { GenerationInput } from '../context/assemble.js';
import { ModelOperation, type ModelDependencies } from '../model.js';
import type { OperationDefinition } from '../operation.js';
import type { Runtime } from '../../runtime/runtime.js';

export const generateAnswerDefinition = {
  name: 'answer',
  label: '生成回答',
  remote: true,
  source: 'src/server/operations/answer/generate.ts · createGenerateAnswer',
  phaseSource: 'src/server/operations/model.ts',
} as const satisfies OperationDefinition;

const task = `根据提供的相关历史与当前 query，用中文回答用户。kind 只能是 answer（能够回答）、unknown（缺乏知识或实际能力）、needs-info（需要用户补充信息）。三种结果都直接返回，不执行工具。本服务没有联网检索、实时天气或工具调用能力；不得编造实时数据。content 是实际给用户的文字，非空。历史可能是不完整的，信息不足时澄清，不擅自补齐条件。示例 JSON：{"kind":"needs-info","content":"你想查询哪个城市？"}`;

export function createGenerateAnswer(runtime: Runtime, dependencies: ModelDependencies) {
  return new ModelOperation<GenerationInput, GenerationOutput>(
    runtime,
    {
      ...generateAnswerDefinition,
      purpose: 'answer',
      task,
      output: answerOutputContract,
      prepare: (input) => ({ query: input.query.content, history: input.messages.map(({ index, message }) => ({ index, ...message })) }),
    },
    dependencies,
  );
}
