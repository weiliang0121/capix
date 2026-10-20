import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { Scene, checkpointPoint, childReference, type SceneWork } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { PrepareConversationContext } from './group/context/prepare.js';
import { MaintainConversationContent, type ContextMaintenancePolicy } from './group/context/maintain.js';
import { acceptConversationRequest } from './accept.js';
import { conversationSceneRequests, type ConversationSceneResources } from './resources.js';
import { GenerateAnswer } from './group/answer/generate.js';
import { ExtractMemory } from './group/memory/extract.js';
import { ProcessDocument } from './group/document/process.js';
import { SaveResult } from './group/document/save.js';
import { DefaultConversationDecision } from './decision/default.js';
import type { ConversationDecisionGroup } from './decision/types.js';
import { CheckFileTask } from './group/preflight/check.js';
import { ConversationGroup, type ConversationCapabilities } from './conversation.js';
import { checkpointCodec, conversationCheckpointInput, conversationCheckpointOutput } from './checkpoint.js';

export interface ConversationDefinitionOptions {
  readonly files?: boolean;
  readonly decision?: ConversationDecisionGroup;
  readonly maxDecisionSteps?: number;
  readonly maintenance?: ContextMaintenancePolicy;
}

/** Scene behavior owns admission and calls its explicitly supplied conversation group. */
export class ConversationScene extends Scene<unknown, GenerationOutput, ConversationSceneResources> {
  readonly filesEnabled;
  readonly customDecision;
  readonly customMaintenance;
  readonly maxDecisionSteps;
  readonly executionWaiting;

  constructor(
    private readonly conversation: ConversationGroup,
    options: ConversationDefinitionOptions = {},
  ) {
    super();
    this.filesEnabled = Boolean(options.files);
    this.customDecision = options.decision !== undefined;
    this.customMaintenance = options.maintenance !== undefined;
    this.maxDecisionSteps = conversation.maxDecisionSteps;
    this.add(conversation);
    this.executionWaiting = checkpointPoint<'scene', unknown, GenerationOutput>()({
      name: 'executionWaiting',
      state: checkpointCodec(z.strictObject({})),
      references: { execution: childReference(conversation) },
      check: (_state, facts) => {
        const child = facts.references.execution;
        if (facts.children.values().length !== 1 || child.key !== 'conversation') throw new Error('Conversation checkpoint must identify its direct execution');
      },
      resume: {
        requires: {},
        uses: [conversation],
        execute: async (work, _state, saved) => {
          const child = work.children.resume(saved.execution);
          await child.run();
          return child.accept();
        },
      },
    });
    this.setDefinition({
      name: 'conversation',
      label: '对话场景',
      observation: [invocationRecording()],
      checkpoint: { key: 'observer.conversation.scene', version: 4, input: conversationCheckpointInput, output: conversationCheckpointOutput, points: [this.executionWaiting] },
      run: { requires: conversationSceneRequests, uses: [conversation], execute: this.execute.bind(this) },
    });
  }

  private async execute(work: SceneWork<unknown, GenerationOutput, ConversationSceneResources>): Promise<GenerationOutput> {
    const accepted = acceptConversationRequest(work.input, work.resources.messages.append, this.filesEnabled);
    const child = work.children.create(this.conversation, accepted, { key: 'conversation' });
    work.checkpoint?.save(this.executionWaiting, {}, { execution: child.ref });
    await child.run();
    return child.accept();
  }
}

/** Construction references have no identity or lifetime beyond the structures they name. */
export interface ConversationStructure extends ConversationCapabilities {
  readonly scene: ConversationScene;
  readonly conversation: ConversationGroup;
}

/** Construct once, retaining the exact targets needed by later source and resource bindings. */
export function createConversationStructure(options: ConversationDefinitionOptions = {}): ConversationStructure {
  const files = Boolean(options.files);
  const maintenance = options.maintenance ? new MaintainConversationContent(options.maintenance) : undefined;
  const preparation = new PrepareConversationContext(maintenance);
  const generation = new GenerateAnswer({ files });
  const extraction = new ExtractMemory();
  const decision = options.decision ?? new DefaultConversationDecision({ files });
  const preflight = files ? new CheckFileTask() : undefined;
  const document = files ? new ProcessDocument() : undefined;
  const save = files ? new SaveResult() : undefined;
  const capabilities: ConversationCapabilities = { preparation, generation, extraction, decision, maintenance, preflight, document, save };
  const conversation = new ConversationGroup(capabilities, { maxDecisionSteps: options.maxDecisionSteps });
  const scene = new ConversationScene(conversation, options);
  return { scene, conversation, ...capabilities };
}
