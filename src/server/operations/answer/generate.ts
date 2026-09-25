import { sortBy } from 'es-toolkit/array';
import type { ModelRequest } from '../../../shared/types.js';
import type { ExecutionContext } from '../../context/execution.js';
import { checkCapacity, estimateCapacity } from '../model/capacity.js';
import type { GenerationOutput } from '../../../shared/operations/generation.js';
import { answerOutputContract } from './output.js';
import type { GenerationInput as AssembledInput } from '../context/assemble.js';
import { ModelOperation } from '../model.js';
import type { Memory } from '../../memory/memory.js';

export interface GenerationInput extends AssembledInput {
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

export class GenerateAnswer extends ModelOperation<GenerationInput, GenerationOutput> {
  readonly name = 'answer';
  readonly label = '生成回答';
  readonly source = 'src/server/operations/answer/generate.ts · GenerateAnswer';
  protected readonly purpose = 'answer';
  protected readonly output = answerOutputContract;
  protected readonly task = `根据当前 message、所选 history 和 memories，用中文完成用户本次请求。history 仅包含当前消息段的所选原文，memories 是跨段保留的理解；旧原文可能已不在本次上下文中，可以依据记忆继续交流，但记忆不是已验证事实。当前明确的补充和纠正优先；记忆未保留的必要细节不要补造。
判断原文的适用对象、场景和时效，不把一次选择泛化成永久偏好，也不把一个人的条件转移给另一个人。结合原文语境处理补充、例外与纠正，区分建议、推测、确认和已经发生的事情；重复表达不构成独立证据。明确的纠正应修正对应认识；不能消解的冲突或会影响答案的缺失信息需要如实说明或有针对性地澄清，不为凑成完整答案而补造。
回答应直接服务当前请求，已有足够依据时正常完成，不额外索要已经明确的信息。kind 只能是 answer（能够回答）、unknown（缺乏知识或实际能力）、needs-info（需要用户补充信息）。content 是实际给用户的非空文字。三种结果都直接返回，不执行工具；本服务没有联网检索、实时天气或工具调用能力，不得编造实时数据。示例 JSON：{"kind":"needs-info","content":"你想查询哪个城市？"}`;

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
    return { message: input.message, memories: input.memories, history: sortBy(input.selectedMessages, ['index']).map(({ index, message }) => ({ index, ...message })) };
  }
}
