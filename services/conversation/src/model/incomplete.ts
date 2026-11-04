/** Safe public diagnostic; never includes model text, request material or credentials. */
export class ModelCompletionIncomplete extends Error {
  readonly code: 'MODEL_OUTPUT_LIMIT' | 'MODEL_COMPLETION_INCOMPLETE';
  readonly finishReason: 'length' | 'other';

  constructor(
    reason: string,
    readonly maxTokens?: number,
  ) {
    const limited = reason === 'length';
    super(limited ? `模型输出达到${maxTokens === undefined ? '配置的' : ` ${maxTokens} token `}上限，截断内容未接纳。` : '模型未正常结束，返回内容未接纳。');
    this.name = 'ModelCompletionIncomplete';
    this.code = limited ? 'MODEL_OUTPUT_LIMIT' : 'MODEL_COMPLETION_INCOMPLETE';
    this.finishReason = limited ? 'length' : 'other';
  }
}
