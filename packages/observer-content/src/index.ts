/** Observer content ownership and its host synchronization utilities; not a general conversation runtime. */
export { ConversationContent, type ConversationContentOptions } from './content.js';
export type { ContentObservation } from './observation.js';
export type { ConversationContentState, ConversationContentPersistence } from './persistence.js';
export { ChangeConsumer } from './synchronization/consumer.js';
export { TranscriptFeed, transcriptSnapshot } from './synchronization/transcript.js';

// Observer's active transcript/memory policy and its resource operations.
export { ActiveView } from './view/active.js';
export { initialActiveView, appendActiveView } from './view/default-policy.js';
export { freezeActiveView, type ActiveViewState, type ActiveViewBasis, type ActiveViewSnapshot, type ActiveViewSelection, type ActiveViewPersistence } from './view/state.js';
export { ActiveViewResource, type ActiveViewReader, type ActiveViewManager } from './view/resource.js';
