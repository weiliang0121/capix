import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import { createMaterialAnswer } from '../materials/answer.js';
import { createMaterialPreparation } from '../materials/input.js';
import { createContentMaintenance } from '../memory/content.js';
import { createInteractionCompletion } from '../model/completion.js';
import { createRecoverableConversationScene } from '../recovery/scene.js';

/** This service's default policy; all members are ordinary, independently usable structures. */
export function createMaterialConversationScene(outputBudget: Partial<ConversationOutputBudget> = {}) {
  const budget = resolveConversationOutputBudget(outputBudget);
  return createRecoverableConversationScene(createMaterialAnswer(createInteractionCompletion(), budget.answer), createMaterialPreparation(), createContentMaintenance(budget.memory), budget);
}
