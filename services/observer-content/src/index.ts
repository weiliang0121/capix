/** Observer content ownership and its host synchronization utilities; not a general conversation runtime. */
export { ConversationContent, type ConversationContentOptions } from './content.js';
export type { ContentObservation } from './observation.js';
export type { ConversationContentState, ConversationContentPersistence } from './persistence.js';
export { ChangeConsumer } from './synchronization/consumer.js';
export { TranscriptFeed, transcriptSnapshot } from './synchronization/transcript.js';

// Observer's active transcript/memory policy and its resource operations.
export { ActiveView, initialActiveView, appendActiveView, freezeActiveView } from './view/active.js';
export type { ActiveViewState, ActiveViewBasis, ActiveViewSnapshot, ActiveViewSelection, ActiveViewPersistence } from './view/active.js';
export { ActiveViewResource, type ActiveViewReader, type ActiveViewManager } from './view/resource.js';
