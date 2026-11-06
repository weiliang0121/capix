import type { InteractionChannel } from '@capix/interaction';
import type { ModelReply, ModelRequest, ModelRequestInspection } from '@capix/model-provider';
import { Resource } from '@capix/resources';
import { Resources } from '@capix/server-runtime';
import { createArchivedToolAnswer, registerArchivedToolResources, type ToolHostOptions } from '../hosting/tool-answer.js';
import { resolveToolConversationPolicy, type ToolConversationPolicyOptions } from '../hosting/tool-policy.js';
import { createHistoryTools } from '../history/tools/nodes.js';
import { HistoryToolResource } from '../history/tools/resource.js';
import { ToolPreparationResource, createToolPreparation } from '../history/tools/prepare.js';
import type { ConversationViewSource } from '../materials/view.js';
import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import { createContentMaintenance } from '../memory/content.js';
import { createRecoverableToolConversationScene } from '../recovery/tools.js';
import { createToolLoop } from '../tools/loop.js';
import type { ToolInteractionRecovery } from '../tools/model.js';

/** Fixed structures and resource wiring only. The caller owns content, archive use and channel. */
export function createToolConversationParts(content: ConversationViewSource, outputBudget: Partial<ConversationOutputBudget> = {}, configuration: ToolConversationPolicyOptions = {}) {
  const budget = resolveConversationOutputBudget(outputBudget);
  const policy = resolveToolConversationPolicy(configuration);
  const tools = createHistoryTools(policy);
  // Includes search/fragment/material policies that are not fully represented by JSON Schema.
  const policyVersion = JSON.stringify({ version: policy.version, history: policy.history, maxMaterialBytes: policy.maxMaterialBytes });
  const loop = createToolLoop({ tools, policyVersion, checkpoint: true, maxModelCalls: policy.maxModelCalls, waitMs: policy.modelWaitMs, budgets: policy.budgets });
  const answer = createArchivedToolAnswer(loop, budget.answer);
  const prepare = createToolPreparation(policy.maxMaterialBytes);
  const maintain = createContentMaintenance(budget.memory);
  const scene = createRecoverableToolConversationScene(answer, prepare, maintain, loop, budget);
  return Object.freeze({
    scene,
    answer,
    loop,
    prepare,
    maintain,
    policy,
    register<Options extends ToolHostOptions>(resources: Resources<Options>, channel: InteractionChannel<ModelRequest, ModelReply, string>, recovery: ToolInteractionRecovery, inspectRequest: (request: ModelRequest) => ModelRequestInspection): void {
      resources.register(new Resource(content), ToolPreparationResource);
      const capture = registerArchivedToolResources(resources, answer, loop, channel, inspectRequest, recovery, budget.answer);
      // The same answer capture supplies both the archive and query-scoped historical reads.
      // No mutable current query or independently reconstructed source selection is retained.
      capture.register(HistoryToolResource, ({ input }) => ({ transcript: content.transcript, query: input.query, policy }));
    },
  });
}
