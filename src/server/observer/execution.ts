import { Execution } from '../execution/execution.js';
import type { ExecutionContext } from '../context/execution.js';
import type { Message } from '../../shared/transcript/message.js';
import type { GenerationOutput } from '../../shared/operations/generation.js';
import type { ModelProvider } from '../provider.js';
import type { Runtime } from '../runtime/runtime.js';
import { SelectHistory } from '../operations/history/select.js';
import { AssembleContext } from '../operations/context/assemble.js';
import { GenerateAnswer } from '../operations/answer/generate.js';

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecution extends Execution<Readonly<Message>, GenerationOutput> {
  readonly selection: SelectHistory;
  readonly assembly: AssembleContext;
  readonly generation: GenerateAnswer;

  constructor(runtime: Runtime, provider: ModelProvider) {
    super(runtime);
    this.selection = new SelectHistory(runtime, provider);
    this.assembly = new AssembleContext(runtime);
    this.generation = new GenerateAnswer(runtime, provider);
  }

  protected async execute(context: ExecutionContext<Readonly<Message>, GenerationOutput>): Promise<GenerationOutput> {
    const selectionInput = context.input;
    const selectionOutput = await this.selection.call(context, selectionInput);
    const assemblyOutput = await this.assembly.call(context, selectionOutput);
    const generationOutput = await this.generation.call(context, assemblyOutput);
    context.transcriptRange!.transcript.append({ role: 'assistant', content: generationOutput.content });
    return generationOutput;
  }
}
