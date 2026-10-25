import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { Scene, checkpointPoint, childReference, type SceneWork } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { acceptConversationRequest } from './accept.js';
import { conversationSceneRequests, type ConversationSceneResources } from './resources.js';
import { ConversationGroup } from './conversation.js';
import type { ConversationStructureOptions } from './structure.js';
import { checkpointCodec, conversationCheckpointInput, conversationCheckpointOutput } from './checkpoint.js';

/** Scene behavior owns admission and calls its explicitly supplied conversation group. */
export class ConversationScene extends Scene<unknown, GenerationOutput, ConversationSceneResources> {
  readonly filesEnabled;
  readonly customDecision;
  readonly customMaintenance;
  readonly maxDecisionSteps;
  readonly executionWaiting;

  constructor(
    private readonly conversation: ConversationGroup,
    options: ConversationStructureOptions = {},
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
        deps: {},
        uses: [conversation],
        run: async (work, _state, saved) => {
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
      deps: conversationSceneRequests,
      uses: [conversation],
      run: this.execute.bind(this),
    });
  }

  private async execute(work: SceneWork<unknown, GenerationOutput, ConversationSceneResources>): Promise<GenerationOutput> {
    const accepted = acceptConversationRequest(work.input, work.resources.messages.append, this.filesEnabled);
    const child = work.children.create(this.conversation, accepted, { key: 'conversation' });
    work.checkpoint?.({ point: this.executionWaiting, state: {}, refs: { execution: child.ref } });
    await child.run();
    return child.accept();
  }
}
