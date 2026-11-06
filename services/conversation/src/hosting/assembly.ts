import type { ModelProvider } from '@capix/model-provider';
import type { CheckpointStore } from '@capix/checkpoint';
import { Resources, type RunnerObservation, type RunnerOutput } from '@capix/server-runtime';
import type { ConversationViewSource } from '../materials/view.js';
import type { ConversationStore } from '../persistence/store.js';
import { createConversationInteractions } from '../assembly/interactions.js';
import { createMaterialConversationScene } from '../assembly/structure.js';
import { registerConversationResources } from '../assembly/resources.js';
import { createToolConversationParts } from '../assembly/tools.js';
import { CompletionInteraction } from '../model/completion-contract.js';
import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import { assertConversationRecovery, listConversationRecoveries } from '../recovery/basis.js';
import { assertToolConversationRecovery, listToolConversationRecoveries } from '../recovery/tools.js';
import { ToolExchanges, type ToolExchangeUse } from './tool-exchanges.js';
import type { ToolHostOptions } from './tool-answer.js';
import { createToolConversationInteractions } from './tool-model.js';
import { readToolCheckpoint } from './tool-checkpoint.js';
import { assertArchiveAdmission, type ArchiveAdmissionPolicy } from './archive-admission.js';
import { resolveArchiveAdmissionPolicy, type ConversationAnswerMode } from './options.js';
import type { ToolConversationPolicyOptions } from './tool-policy.js';

export interface ConversationHostAssemblyOptions {
  readonly content: ConversationViewSource;
  readonly store: ConversationStore;
  readonly model: ModelProvider;
  readonly configuration: string;
  readonly answerMode?: ConversationAnswerMode;
  readonly outputBudget?: Partial<ConversationOutputBudget>;
  readonly archivePolicy?: Partial<ArchiveAdmissionPolicy>;
  readonly toolPolicy?: ToolConversationPolicyOptions;
}

interface HostRunner {
  readonly isRunning: boolean;
  readonly output: RunnerOutput<string, string>;
  readonly observation: RunnerObservation;
  run(input: string, options: ToolHostOptions & { readonly signal?: AbortSignal }): Promise<string>;
  resume(contextId: string, options: ToolHostOptions & { readonly signal?: AbortSignal }): Promise<string>;
  cancel(reason?: unknown): boolean;
}

/** Fixed host assembly shared by CLI and HTTP. The host still creates/builds Runner,
 * installs observers, and closes its store and independent senders explicitly.
 */
export function createConversationHostAssembly(options: ConversationHostAssemblyOptions) {
  const { content, store, model, configuration } = options;
  const answerMode = options.answerMode ?? 'material';
  if (answerMode !== 'material' && answerMode !== 'tools') throw new TypeError('Unknown conversation answer mode');
  const budget = resolveConversationOutputBudget(options.outputBudget);
  const archivePolicy = resolveArchiveAdmissionPolicy(options.archivePolicy);
  const parts = answerMode === 'tools' ? createToolConversationParts(content, budget, options.toolPolicy) : undefined;
  const inspectRequest = parts ? model.inspectRequest?.bind(model) : undefined;
  const resources = new Resources<ToolHostOptions>();
  const exchanges = new ToolExchanges(store.exchanges);
  registerConversationResources(resources, content, model, store.view, configuration);
  const interactions = parts ? createToolConversationInteractions(model, store.interactions, parts.loop.budgets) : createConversationInteractions(model, store.interactions);
  try {
    if (parts) {
      if (!inspectRequest) throw new TypeError('Tool host requires provider request inspection');
      parts.register(resources, interactions.bind(CompletionInteraction), store.interactions, inspectRequest);
    }
    const scene = parts?.scene ?? createMaterialConversationScene(budget);
    const checkpoints: CheckpointStore = { read: (contextId) => readToolCheckpoint(store.checkpoints, contextId), save: (image, revision) => store.checkpoints.save(image, revision), finish: (contextId, revision, delivery) => store.checkpoints.finish(contextId, revision, delivery) };
    const assertAvailable = () => store.assertAvailable();
    const assertAdmission = (): undefined => {
      assertAvailable();
      assertArchiveAdmission(store.archiveUsage(), interactions.pendingCount, archivePolicy);
      return undefined;
    };
    const check = (contextId: string, exchangeUse: ToolExchangeUse) => (parts ? assertToolConversationRecovery(content, store, configuration, contextId, { loop: parts.loop, outputBudget: budget, exchangeUse, inspectRequest }) : assertConversationRecovery(content, store, configuration, contextId, budget));
    return {
      scene,
      resources,
      interactions,
      checkpoints,
      toolLoop: parts?.loop,
      exchanges,
      archivePolicy,
      assertAvailable,
      assertAdmission,
      listRecoveries: () => (parts ? listToolConversationRecoveries(content, store, configuration, { loop: parts.loop, outputBudget: budget }) : listConversationRecoveries(content, store, configuration, budget)),
      checkRecovery(contextId: string) {
        const use = exchanges.openUse();
        try {
          return check(contextId, use);
        } finally {
          use.close();
        }
      },
      /** This adapter owns only per-entry supply handles. It delegates busy state,
       * cancellation, output and observation directly to the actual Runner.
       */
      entry(runner: HostRunner) {
        return {
          get isRunning() {
            return runner.isRunning;
          },
          output: runner.output,
          observation: runner.observation,
          cancel: (reason?: unknown) => runner.cancel(reason),
          async run(input: string, controls: { readonly signal?: AbortSignal } = {}) {
            const use = exchanges.openUse();
            try {
              return await runner.run(input, { ...controls, exchangeUse: use });
            } finally {
              use.close();
            }
          },
          async resume(contextId: string, controls: { readonly signal?: AbortSignal } = {}) {
            const use = exchanges.openUse();
            try {
              // Preserve Runner's busy rejection. Idle admission and eligibility
              // are synchronous and checked immediately before the real entry.
              if (!runner.isRunning) {
                assertAdmission();
                check(contextId, use);
              }
              return await runner.resume(contextId, { ...controls, exchangeUse: use });
            } finally {
              use.close();
            }
          },
        };
      },
    };
  } catch (error) {
    interactions.close();
    throw error;
  }
}
