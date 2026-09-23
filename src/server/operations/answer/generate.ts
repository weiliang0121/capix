import type { ModelRequest } from '../../../shared/types.js';
import type { ExecutionContext } from '../../context/execution.js';
import { checkCapacity, estimateCapacity } from '../model/capacity.js';
import type { GenerationOutput } from '../../../shared/operations/generation.js';
import { answerOutputContract } from './output.js';
import type { GenerationInput } from '../context/assemble.js';
import { ModelOperation } from '../model.js';

export class GenerateAnswer extends ModelOperation<GenerationInput, GenerationOutput> {
  readonly name = 'answer';
  readonly label = '生成回答';
  readonly source = 'src/server/operations/answer/generate.ts · GenerateAnswer';
  protected readonly purpose = 'answer';
  protected readonly output = answerOutputContract;
  protected readonly task = `根据提供的相关历史与当前 message，用中文回答用户。kind 只能是 answer（能够回答）、unknown（缺乏知识或实际能力）、needs-info（需要用户补充信息）。三种结果都直接返回，不执行工具。本服务没有联网检索、实时天气或工具调用能力；不得编造实时数据。content 是实际给用户的文字，非空。历史可能是不完整的，信息不足时澄清，不擅自补齐条件。示例 JSON：{"kind":"needs-info","content":"你想查询哪个城市？"}`;

  protected createRequest(input: GenerationInput, execution: ExecutionContext): ModelRequest {
    const selectedMessages: GenerationInput['selectedMessages'][number][] = [];
    let request = super.createRequest({ ...input, selectedMessages }, execution);
    checkCapacity(request, execution.settings);

    for (const selected of input.selectedMessages) {
      selectedMessages.push(selected);
      const candidate = super.createRequest({ ...input, selectedMessages }, execution);
      if (!estimateCapacity(candidate, execution.settings).fits) {
        // Never replace a higher-priority message with smaller, lower-priority ones.
        if (selectedMessages.length === 1) checkCapacity(candidate, execution.settings);
        break;
      }
      request = candidate;
    }
    return request;
  }

  protected prepare(input: GenerationInput) {
    return { message: input.message, history: [...input.selectedMessages].sort((a, b) => a.index - b.index).map(({ index, message }) => ({ index, ...message })) };
  }
}
