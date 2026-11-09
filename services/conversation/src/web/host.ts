import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import type { ModelProvider } from '@weiliang0121/capix-model-provider';
import { Runner } from '@weiliang0121/capix-runtime';
import { loadConversationContent } from '../assembly/index.js';
import { ConversationStore } from '../persistence/index.js';
import { ConversationRecording } from '../recording/index.js';
import { ConversationEvents } from '../http/events.js';
import { createConversationServer } from '../http/server.js';
import { hostRecoveryConfiguration } from '../hosting/model.js';
import { RecoveryActivity } from '../hosting/recovery.js';
import { createConversationHostAssembly } from '../hosting/assembly.js';
import type { ConversationAnswerMode } from '../hosting/options.js';
import type { ArchiveAdmissionPolicy } from '../hosting/archive-admission.js';
import { ToolStages } from '../hosting/tool-stages.js';

export interface ConversationWebHostOptions {
  readonly database: string;
  readonly model: ModelProvider;
  readonly mode: 'demo' | 'live';
  readonly answerMode?: ConversationAnswerMode;
  readonly modelName: string;
  /** Custom hosts must change this when provider endpoint/configuration or policy changes. */
  readonly recoveryConfiguration?: string;
  readonly outputBudget?: Partial<ConversationOutputBudget>;
  readonly archivePolicy?: Partial<ArchiveAdmissionPolicy>;
  readonly assetsDirectory?: string;
}

/** The executable host owns the store and independent senders; HTTP only consumes their ports. */
export function createConversationWebHost(options: ConversationWebHostOptions) {
  const budget = resolveConversationOutputBudget(options.outputBudget);
  const store = ConversationStore.open(options.database);
  let interactions: ReturnType<typeof createConversationHostAssembly>['interactions'] | undefined;
  let http: ReturnType<typeof createConversationServer> | undefined;
  let recoveryActivity: RecoveryActivity | undefined;
  let stages: ToolStages | undefined;
  const answerMode = options.answerMode ?? 'material';
  const configuration = options.recoveryConfiguration ?? hostRecoveryConfiguration(options.mode, options.modelName, budget, answerMode);
  try {
    const content = loadConversationContent(store);
    const assembly = createConversationHostAssembly({ content, store, model: options.model, answerMode, configuration, outputBudget: budget, archivePolicy: options.archivePolicy });
    interactions = assembly.interactions;
    const scene = assembly.scene;
    const events = new ConversationEvents(content.transcript);
    const recording = new ConversationRecording(scene);
    const runner = new Runner(scene, assembly.resources, interactions, {
      observations: [recording, events.observation],
      checkpoints: { store: assembly.checkpoints, feedback: events.checkpoint },
      validate: assembly.assertAdmission,
    }).build();
    const activity = new RecoveryActivity(runner.observation);
    recoveryActivity = activity;
    stages = assembly.toolLoop ? new ToolStages(runner.observation, assembly.toolLoop) : undefined;
    http = createConversationServer({
      runner: assembly.entry(runner),
      transcript: content.transcript,
      events,
      mode: options.mode,
      answerMode,
      model: options.modelName,
      assertAvailable: assembly.assertAvailable,
      assertAdmission: assembly.assertAdmission,
      stages,
      inspect: () => recording.inspect(content),
      call: (id) => recording.call(id),
      recording,
      assetsDirectory: options.assetsDirectory,
      recovery: {
        list: assembly.listRecoveries,
        check: assembly.checkRecovery,
        activity: () => activity.snapshot(),
      },
    });
  } catch (error) {
    const failures = [error];
    try {
      recoveryActivity?.close();
      stages?.close();
      http?.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      interactions?.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      store.close();
    } catch (cause) {
      failures.push(cause);
    }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Conversation host initialization failed');
  }
  const active = http;
  const senders = interactions;
  let closing: Promise<void> | undefined;
  return { server: active.server, close: () => (closing ??= close()) };

  async function close(): Promise<void> {
    const failures: unknown[] = [];
    active.stop();
    // Stop admission first; existing feedback consumers can still see the local terminal result.
    const stopped = new Promise<void>((resolve) =>
      active.server.close((error) => {
        if (error && Reflect.get(error, 'code') !== 'ERR_SERVER_NOT_RUNNING') failures.push(error);
        resolve();
      }),
    );
    try {
      await active.settled();
    } catch (error) {
      failures.push(error);
    }
    try {
      await senders.settled();
    } catch (error) {
      failures.push(error);
    }
    try {
      active.close();
      recoveryActivity?.close();
      stages?.close();
    } catch (error) {
      failures.push(error);
    }
    active.server.closeAllConnections();
    await stopped;
    try {
      senders.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      store.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Conversation host shutdown failed');
  }
}
