import { Execution } from '../execution/execution.js';
import type { ExecutionContext } from '../context/execution.js';
import type { MessageRef } from '../transcript/ref.js';
import type { Answer } from '../../shared/types.js';
import type { ModelProvider } from '../provider.js';
import type { Runtime } from '../runtime/runtime.js';
import { selectionInput } from '../operations/history/input.js';
import { createSelectHistory } from '../operations/history/select.js';
import { AssembleContext } from '../operations/context/assemble.js';
import { createGenerateAnswer } from '../operations/answer/generate.js';

export class QueryExecution extends Execution<MessageRef, Answer> {
  constructor(
    runtime: Runtime,
    private readonly provider: ModelProvider,
  ) {
    super(runtime);
  }

  protected async execute(context: ExecutionContext<MessageRef, Answer>): Promise<Answer> {
    const dependencies = { settings: context.settings, signal: context.signal, provider: this.provider };
    const selectHistory = createSelectHistory(this.runtime, dependencies);
    const assemble = new AssembleContext(this.runtime);
    const generateAnswer = createGenerateAnswer(this.runtime, dependencies);
    const input = selectionInput(context.input);
    const selection = await selectHistory.call(context, input);
    const assembled = await assemble.call(context, { original: input, selection });
    const answer = await generateAnswer.call(context, assembled);
    context.input.transcript.append({ role: 'assistant', content: answer.content });
    return answer;
  }
}
