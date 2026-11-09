import { Resources, Runner, RecordingInstallation } from '@weiliang0121/capix-runtime';
import { registerConversationResources, registerConversationRecording, ConversationCallCapture, conversationCallHooks } from '@capix/observer-service/conversation';

/** Service tests exercise the same resource registration and Runner path as the host. */
export function createConversationRunner(structure, entities, model, mechanisms = {}, options = {}) {
  const resources = new Resources();
  for (const observation of mechanisms.observations ?? []) {
    if (observation instanceof RecordingInstallation) registerConversationRecording(observation, structure);
  }
  const capture = new ConversationCallCapture(structure.scene, entities, { ...options, checkpoints: mechanisms.checkpoints?.store });
  registerConversationResources(resources, structure, entities, model, capture);
  return new Runner(structure.scene, resources, undefined, { ...mechanisms, validate: (options) => capture.validate(options), hooks: conversationCallHooks(structure, capture) }).build();
}
