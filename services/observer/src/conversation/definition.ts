import { invocationRecording } from '@capix/server-runtime/recording';
import { RuntimeDefinition, type RuntimeContextView, type InvocationWorkView, type ChildBindings, type InvocationCheckpointDefinition } from '@capix/server-runtime';
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
import { checkpointCodec, checkpointChild, conversationCheckpointInput, conversationCheckpointOutput } from './checkpoint.js';

/** Business declarations contain no live environment or model provider. */
export class ConversationRuntimeDefinition extends RuntimeDefinition<unknown, GenerationOutput> {
  readonly observation = [invocationRecording()];
  readonly executionDefinition;
  readonly children;
  readonly filesEnabled;
  readonly customDecision;
  readonly checkpoint: InvocationCheckpointDefinition<unknown, GenerationOutput, RuntimeContextView<unknown, GenerationOutput>>;
  constructor(options: { files?: boolean; decision?: ConversationDecisionDefinition; maxDecisionSteps?: number } = {}) {
    super();
    this.filesEnabled = Boolean(options.files);
    this.customDecision = options.decision !== undefined;
    this.executionDefinition = new ConversationExecutionDefinition({ selection: new SelectHistoryDefinition(), generation: new GenerateAnswerDefinition({ files: this.filesEnabled }), extraction: new ExtractMemoryDefinition(), decision: options.decision ?? new DefaultConversationDecisionDefinition({ files: this.filesEnabled }), ...(this.filesEnabled ? { preflight: new CheckFileTaskDefinition(), document: new ProcessDocumentDefinition(), save: new SaveResultDefinition() } : {}) }, { maxDecisionSteps: options.maxDecisionSteps });
    this.children = [this.executionDefinition];
    this.checkpoint = {
      key: 'observer.conversation.runtime',
      version: 1,
      input: conversationCheckpointInput,
      output: conversationCheckpointOutput,
      points: {
        executionWaiting: {
          state: checkpointCodec(checkpointChild),
          check: (frame, state) => {
            const child = frame.children[0];
            if (frame.children.length !== 1 || !child || child.identity.contextId !== state.childId || child.key !== 'conversation' || child.contract?.key !== 'observer.conversation.execution') throw new Error('Conversation checkpoint must identify its direct execution');
          },
          resume: {
            requires: {},
            uses: this.children,
            execute: async (_context, invocation, children, state) => {
              const child = children.get(this.executionDefinition).resume(invocation, state.childId);
              await child.run();
              return children.accept(child, (delivered) => delivered);
            },
          },
        },
      },
    };
    this.run = {
      requires: {},
      uses: this.children,
      execute: this.execute.bind(this),
    };
  }
  readonly run;
  private async execute(context: RuntimeContextView<unknown, GenerationOutput>, invocation: InvocationWorkView<unknown, GenerationOutput, RuntimeContextView<unknown, GenerationOutput>>, children: ChildBindings): Promise<GenerationOutput> {
    const child = children.get(this.executionDefinition).create(invocation, context.currentInput, { key: 'conversation' });
    invocation.checkpoint?.save('executionWaiting', { childId: child.context.id });
    await child.run();
    return children.accept(child, (delivered) => delivered);
  }
}
