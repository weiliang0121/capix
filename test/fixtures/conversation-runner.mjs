import { Resources, Runner } from '@capix/server-runtime';
import { registerConversationResources } from '@capix/observer-service/conversation';

/** Service tests exercise the same resource registration and Runner path as the host. */
export function createConversationRunner(structure, entities, model, mechanisms = {}, options = {}) {
  const resources = new Resources();
  const hooks = registerConversationResources(resources, structure, entities, model, { ...options, checkpoints: mechanisms.checkpoints?.store });
  return new Runner(structure.scene, resources, undefined, { ...mechanisms, ...hooks }).build();
}
