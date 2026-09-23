import { Execution } from '../execution/execution.js';
import type { ExecutionContext } from '../context/execution.js';
import type { MessageRef } from '../transcript/ref.js';
import type { GenerationOutput } from '../../shared/operations/generation.js';
import type { ModelProvider } from '../provider.js';
import type { Runtime } from '../runtime/runtime.js';
import { selectionInput as prepareSelectionInput } from '../operations/history/input.js';
import { createSelectHistory } from '../operations/history/select.js';
import { AssembleContext } from '../operations/context/assemble.js';
import { createGenerateAnswer } from '../operations/answer/generate.js';

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecution extends Execution<MessageRef, GenerationOutput> {
  readonly selection: ReturnType<typeof createSelectHistory>;
  readonly assembly: AssembleContext;
  readonly generation: ReturnType<typeof createGenerateAnswer>;

  constructor(runtime: Runtime, provider: ModelProvider) {
    super(runtime);
    this.selection = createSelectHistory(runtime, { provider });
    this.assembly = new AssembleContext(runtime);
    this.generation = createGenerateAnswer(runtime, { provider });
  }

  protected async execute(context: ExecutionContext<MessageRef, GenerationOutput>): Promise<GenerationOutput> {
    const selectionInput = prepareSelectionInput(context.input);
    const selectionOutput = await this.selection.call(context, selectionInput);
    const assemblyOutput = await this.assembly.call(context, { original: selectionInput, selection: selectionOutput });
    const generationOutput = await this.generation.call(context, assemblyOutput);
    context.input.transcript.append({ role: 'assistant', content: generationOutput.content });
    return generationOutput;
  }
}
