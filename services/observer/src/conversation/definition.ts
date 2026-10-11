import { invocationRecording } from '@capix/server-runtime/recording';
import { RuntimeDefinition, type RuntimeContextView, type InvocationView, type ChildBindings } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { SelectHistoryDefinition } from './operations/history/select.js';
import { GenerateAnswerDefinition } from './operations/answer/generate.js';
import { ExtractMemoryDefinition } from './operations/memory/extract.js';
import { ProcessDocumentDefinition } from './operations/document/process.js';
import { SaveResultDefinition } from './operations/document/save.js';
import { DefaultConversationDecisionDefinition } from './decision/default.js';
import type { ConversationDecisionDefinition } from './decision/types.js';
import { CheckFileTaskDefinition } from './operations/preflight/check.js';
import { ConversationExecutionDefinition } from './execution.js';

/** Business declarations contain no live environment or model provider. */
export class ConversationRuntimeDefinition extends RuntimeDefinition<unknown, GenerationOutput> {
  readonly observation = [invocationRecording()];
  readonly executionDefinition;
  readonly children;
  readonly filesEnabled;
  constructor(options: { files?: boolean; decision?: ConversationDecisionDefinition; maxDecisionSteps?: number } = {}) {
    super();
    this.filesEnabled = Boolean(options.files);
    this.executionDefinition = new ConversationExecutionDefinition({ selection: new SelectHistoryDefinition(), generation: new GenerateAnswerDefinition({ files: this.filesEnabled }), extraction: new ExtractMemoryDefinition(), decision: options.decision ?? new DefaultConversationDecisionDefinition({ files: this.filesEnabled }), ...(this.filesEnabled ? { preflight: new CheckFileTaskDefinition(), document: new ProcessDocumentDefinition(), save: new SaveResultDefinition() } : {}) }, { maxDecisionSteps: options.maxDecisionSteps });
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
    await child.run();
    return children.accept(child, (delivered) => delivered);
  }
}
