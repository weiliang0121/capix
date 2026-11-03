import { Group } from '@capix/structure';
import { createMaterialAnswer } from '../materials/answer.js';
import { createMaterialPreparation } from '../materials/input.js';
import { createMessageInclusion } from '../materials/maintenance.js';
import { createMemoryMaintenance } from '../memory/maintenance.js';
import { createInteractionCompletion } from '../model/completion.js';
import { createConversationScene, type AcceptedConversationMessage } from '../scene.js';

/** This service's default policy; all members are ordinary, independently usable structures. */
export function createMaterialConversationScene() {
  const maintain = new Group<AcceptedConversationMessage, void>({ name: 'maintain-conversation-content' }).add({ include: createMessageInclusion(), remember: createMemoryMaintenance() });
  maintain.run = async (work) => {
    await work.children.include.invoke(work.input);
    await work.children.remember.invoke(work.input);
  };
  return createConversationScene(createMaterialAnswer(createInteractionCompletion()), createMaterialPreparation(), maintain);
}
