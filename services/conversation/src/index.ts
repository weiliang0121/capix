/** A parallel reference service built from public resources, structures and Runner. No HTTP or UI. */
export { createConversationRunner } from './runner.js';
export { createConversationScene, type ConversationAnswer, type ConversationPreparation, type ConversationMaintenance, type AcceptedConversationMessage } from './scene.js';
export { createAnswerNode } from './answer.js';
export { HistoryResource } from './history.js';
export { ModelResource, type TextModel } from './model.js';
export { CompletionResource } from './completion.js';
export { createHistoryAnswer } from './summary/answer.js';
export { ConversationViewResource, type ConversationMaterialSources, type ConversationViewSource, type ConversationViewManagementSource } from './materials/view.js';
export { createMessageInclusion } from './materials/maintenance.js';
export { ConversationMemoryResource, type ConversationMemoryContext } from './memory/context.js';
export { createMemoryMaintenance } from './memory/maintenance.js';
export { createMaterialPreparation, type ConversationMaterialInput } from './materials/input.js';
export { createMaterialAnswer } from './materials/answer.js';
export { TextModelInteraction, ModelInteractionResource, type ModelMessages } from './model/interaction.js';
export { createInteractionAnswer, createModelReplyNode, ModelReplyPending } from './model/request.js';
export type { ModelFeedbackInput, ModelProgressInput, ModelProgressDelta } from './model/feedback.js';
