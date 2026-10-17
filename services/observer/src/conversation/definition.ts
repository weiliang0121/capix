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
import { ConversationExecutionDefinition, type ConversationOperationDefinitions } from './execution.js';
import { checkpointCodec, checkpointChild, conversationCheckpointInput, conversationCheckpointOutput } from './checkpoint.js';

export interface ConversationDefinitionOptions {
  readonly files?: boolean;
  readonly decision?: ConversationDecisionDefinition;
  readonly maxDecisionSteps?: number;
}

/** Business declarations contain no live environment or model provider. */
export class ConversationRuntimeDefinition extends RuntimeDefinition<unknown, GenerationOutput> {
  readonly observation = [invocationRecording()];
  readonly executionDefinition;
  readonly children;
  readonly filesEnabled;
  readonly customDecision;
  readonly checkpoint: InvocationCheckpointDefinition<unknown, GenerationOutput, RuntimeContextView<unknown, GenerationOutput>>;
  constructor(options: ConversationDefinitionOptions = {}) {
    super();
    this.filesEnabled = Boolean(options.files);
    this.customDecision = options.decision !== undefined;
    this.executionDefinition = createConversationExecution(options);
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

/** Construct the reusable business tree once; binding and per-call resources come later. */
function createConversationExecution(options: ConversationDefinitionOptions): ConversationExecutionDefinition {
  const files = Boolean(options.files);
  const selection = new SelectHistoryDefinition();
  const generation = new GenerateAnswerDefinition({ files });
  const extraction = new ExtractMemoryDefinition();
  const decision = options.decision ?? new DefaultConversationDecisionDefinition({ files });
  const operations: ConversationOperationDefinitions = { selection, generation, extraction, decision };
  if (!files) return new ConversationExecutionDefinition(operations, { maxDecisionSteps: options.maxDecisionSteps });
  const preflight = new CheckFileTaskDefinition();
  const document = new ProcessDocumentDefinition();
  const save = new SaveResultDefinition();
  return new ConversationExecutionDefinition({ ...operations, preflight, document, save }, { maxDecisionSteps: options.maxDecisionSteps });
}
