/** Active membership over existing transcript and memory entities; no independent content identity. */
export { ActiveView, initialActiveView, appendActiveView, freezeActiveView } from './active.js';
export type { ActiveViewState, ActiveViewBasis, ActiveViewSnapshot, ActiveViewSelection, ActiveViewPersistence } from './active.js';
export { ActiveViewResource, type ActiveViewReader, type ActiveViewManager } from './resource.js';
