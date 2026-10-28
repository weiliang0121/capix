/** A parallel reference service built from public resources, structures and Runner. No HTTP or UI. */
export { createConversationRunner } from './runner.js';
export { createConversationScene, type ConversationAnswer } from './scene.js';
export { createAnswerNode } from './answer.js';
export { HistoryResource } from './history.js';
export { ModelResource, type TextModel } from './model.js';
export { TextModelInteraction, ModelInteractionResource, type ModelMessages } from './model/interaction.js';
export { createInteractionAnswer, createModelReplyNode, ModelReplyPending } from './model/request.js';
export type { ModelFeedbackInput, ModelProgressInput, ModelProgressDelta } from './model/feedback.js';
