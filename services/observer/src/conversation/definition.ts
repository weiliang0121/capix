import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { RuntimeDefinition, checkpointPoint, childReference, type RuntimeWork } from '@capix/server-runtime';
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
import { checkpointCodec, conversationCheckpointInput, conversationCheckpointOutput } from './checkpoint.js';

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
  readonly checkpoint;
  readonly executionWaiting;
  constructor(options: ConversationDefinitionOptions = {}) {
    super();
    this.filesEnabled = Boolean(options.files);
    this.customDecision = options.decision !== undefined;
    this.executionDefinition = createConversationExecution(options);
    this.children = [this.executionDefinition];
    this.executionWaiting = checkpointPoint<'runtime', unknown, GenerationOutput>()({
      name: 'executionWaiting',
      state: checkpointCodec(z.strictObject({})),
      references: { execution: childReference(this.executionDefinition) },
      check: (_state, facts) => {
        const child = facts.references.execution;
        if (facts.children.values().length !== 1 || child.key !== 'conversation') throw new Error('Conversation checkpoint must identify its direct execution');
      },
      resume: {
        requires: {},
        uses: this.children,
        execute: async (work, _state, saved) => {
          const child = work.children.resume(saved.execution);
          await child.run();
          return child.accept();
        },
      },
    });
    this.checkpoint = { key: 'observer.conversation.runtime', version: 2, input: conversationCheckpointInput, output: conversationCheckpointOutput, points: [this.executionWaiting] };
    this.run = {
      requires: {},
      uses: this.children,
      execute: this.execute.bind(this),
    };
  }
  readonly run;
  private async execute(work: RuntimeWork<unknown, GenerationOutput>): Promise<GenerationOutput> {
    const child = work.children.create(this.executionDefinition, work.input, { key: 'conversation' });
    work.checkpoint?.save(this.executionWaiting, {}, { execution: child.ref });
    await child.run();
    return child.accept();
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
