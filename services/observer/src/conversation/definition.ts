import { invocationRecording } from '@capix/server-runtime/recording';
import { RuntimeDefinition, type RuntimeContextView, type InvocationView, type ChildBindings } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { SelectHistoryDefinition } from './operations/history/select.js';
import { GenerateAnswerDefinition } from './operations/answer/generate.js';
import { ExtractMemoryDefinition } from './operations/memory/extract.js';
import { ProcessDocumentDefinition } from './operations/document/process.js';
import { SaveResultDefinition } from './operations/document/save.js';
import { UnderstandRequestDefinition } from './operations/request/understand.js';
import { ConversationExecutionDefinition } from './execution.js';

/** Business declarations contain no live environment or model provider. */
export class ConversationRuntimeDefinition extends RuntimeDefinition<unknown, GenerationOutput> {
  readonly observation = [invocationRecording()];
  readonly executionDefinition;
  readonly children;
  readonly filesEnabled;
  constructor(options: { files?: boolean } = {}) {
    super();
    this.filesEnabled = Boolean(options.files);
    this.executionDefinition = new ConversationExecutionDefinition({ selection: new SelectHistoryDefinition(), generation: new GenerateAnswerDefinition({ files: this.filesEnabled }), extraction: new ExtractMemoryDefinition(), ...(this.filesEnabled ? { understanding: new UnderstandRequestDefinition({ files: true }), document: new ProcessDocumentDefinition(), save: new SaveResultDefinition() } : {}) });
    this.children = [this.executionDefinition];
    this.run = {
      requires: {},
      uses: this.children,
      execute: this.execute.bind(this),
    };
  }
  readonly run;
  private async execute(context: RuntimeContextView<unknown, GenerationOutput>, invocation: InvocationView<unknown, GenerationOutput, RuntimeContextView<unknown, GenerationOutput>>, children: ChildBindings): Promise<GenerationOutput> {
    const child = children.get(this.executionDefinition).create(invocation, context.currentInput, { key: 'conversation' });
    const output = await child.run();
    return children.accept(child, () => output);
  }
}
