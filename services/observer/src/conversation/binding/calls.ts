import { callableHooks } from '@capix/server-runtime';
import type { ConversationStructure } from '../structure.js';
import type { ConversationCallCapture } from './capture.js';
import type { ConversationRunOptions } from './contract.js';
import { activityProgress, answerProgress } from './progress.js';

/** Call registration and passive delivery are independent of resource selection. */
export function conversationCallHooks(structure: ConversationStructure, capture: ConversationCallCapture) {
  capture.assertScope(structure.scene);
  return [
    callableHooks(structure.scene, {
      progress: (_input, options: ConversationRunOptions) => activityProgress(options.activity),
    }),
    callableHooks(structure.conversation, {
      started: (_input, options: ConversationRunOptions) => capture.startedTask(options),
      output: (_input, options: ConversationRunOptions) => answerProgress(options.answerProgress),
    }),
  ];
}
