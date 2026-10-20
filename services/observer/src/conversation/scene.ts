import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { SceneDefinition, checkpointPoint, childReference, type SceneWork } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { PrepareConversationContextDefinition } from './group/context/prepare.js';
import { MaintainConversationContentDefinition, type ContextMaintenancePolicy } from './group/context/maintain.js';
import { acceptConversationRequest } from './accept.js';
import { conversationSceneRequests, type ConversationSceneResources } from './resources.js';
import { GenerateAnswerDefinition } from './group/answer/generate.js';
import { ExtractMemoryDefinition } from './group/memory/extract.js';
import { ProcessDocumentDefinition } from './group/document/process.js';
import { SaveResultDefinition } from './group/document/save.js';
import { DefaultConversationDecisionDefinition } from './decision/default.js';
import type { ConversationDecisionDefinition } from './decision/types.js';
import { CheckFileTaskDefinition } from './group/preflight/check.js';
import { ConversationTaskDefinition, type ConversationOperationDefinitions } from './task.js';
import { checkpointCodec, conversationCheckpointInput, conversationCheckpointOutput } from './checkpoint.js';

export interface ConversationDefinitionOptions {
  readonly files?: boolean;
  readonly decision?: ConversationDecisionDefinition;
  readonly maxDecisionSteps?: number;
  readonly maintenance?: ContextMaintenancePolicy;
}

/** Business declarations contain no live environment or model provider. */
export class ConversationSceneDefinition extends SceneDefinition<unknown, GenerationOutput, ConversationSceneResources> {
  readonly name = 'conversation';
  readonly label = '对话场景';
  readonly observation = [invocationRecording()];
  readonly taskDefinition;
  readonly members;
  readonly filesEnabled;
  readonly customDecision;
  readonly customMaintenance;
  readonly checkpoint;
  readonly executionWaiting;
  constructor(options: ConversationDefinitionOptions = {}) {
    super();
    this.filesEnabled = Boolean(options.files);
    this.customDecision = options.decision !== undefined;
    this.customMaintenance = options.maintenance !== undefined;
    this.taskDefinition = createConversationExecution(options);
    this.members = [this.taskDefinition];
    this.executionWaiting = checkpointPoint<'scene', unknown, GenerationOutput>()({
      name: 'executionWaiting',
      state: checkpointCodec(z.strictObject({})),
      references: { execution: childReference(this.taskDefinition) },
      check: (_state, facts) => {
        const child = facts.references.execution;
        if (facts.children.values().length !== 1 || child.key !== 'conversation') throw new Error('Conversation checkpoint must identify its direct execution');
      },
      resume: {
        requires: {},
        uses: this.members,
        execute: async (work, _state, saved) => {
          const child = work.children.resume(saved.execution);
          await child.run();
          return child.accept();
        },
      },
    });
    this.checkpoint = { key: 'observer.conversation.scene', version: 4, input: conversationCheckpointInput, output: conversationCheckpointOutput, points: [this.executionWaiting] };
    this.run = {
      requires: conversationSceneRequests,
      uses: this.members,
      execute: this.execute.bind(this),
    };
  }
  readonly run;
  private async execute(work: SceneWork<unknown, GenerationOutput, ConversationSceneResources>): Promise<GenerationOutput> {
    const accepted = acceptConversationRequest(work.input, work.resources.messages.append, this.filesEnabled);
    const child = work.children.create(this.taskDefinition, accepted, { key: 'conversation' });
    work.checkpoint?.save(this.executionWaiting, {}, { execution: child.ref });
    await child.run();
    return child.accept();
  }
}

/** Construct the reusable business tree once; binding and per-call resources come later. */
function createConversationExecution(options: ConversationDefinitionOptions): ConversationTaskDefinition {
  const files = Boolean(options.files);
  const maintenance = options.maintenance ? new MaintainConversationContentDefinition(options.maintenance) : undefined;
  const preparation = new PrepareConversationContextDefinition(maintenance);
  const generation = new GenerateAnswerDefinition({ files });
  const extraction = new ExtractMemoryDefinition();
  const decision = options.decision ?? new DefaultConversationDecisionDefinition({ files });
  const operations: ConversationOperationDefinitions = { preparation, generation, extraction, decision, ...(maintenance ? { maintenance } : {}) };
  if (!files) return new ConversationTaskDefinition(operations, { maxDecisionSteps: options.maxDecisionSteps });
  const preflight = new CheckFileTaskDefinition();
  const document = new ProcessDocumentDefinition();
  const save = new SaveResultDefinition();
  return new ConversationTaskDefinition({ ...operations, preflight, document, save }, { maxDecisionSteps: options.maxDecisionSteps });
}
