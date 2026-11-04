import { createMaterialAnswer } from '../materials/answer.js';
import { createMaterialPreparation } from '../materials/input.js';
import { createContentMaintenance } from '../memory/content.js';
import { createInteractionCompletion } from '../model/completion.js';
import { createRecoverableConversationScene } from '../recovery/scene.js';

/** This service's default policy; all members are ordinary, independently usable structures. */
export function createMaterialConversationScene() {
  return createRecoverableConversationScene(createMaterialAnswer(createInteractionCompletion()), createMaterialPreparation(), createContentMaintenance());
}
