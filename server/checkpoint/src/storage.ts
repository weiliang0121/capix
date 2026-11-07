// Host storage adaptation; these helpers do not grant execution or recovery authority.
export { prepareCheckpointCommit, materializeCheckpointHead, checkpointImageCommit } from './incremental.js';
export type { CheckpointStoredValue, CheckpointStoredChild, CheckpointStoredHead, CheckpointCommitReader, CheckpointCommitPlan } from './incremental.js';
export { encodeCheckpointData, decodeCheckpointData } from './encoding.js';
export { encodeCheckpointRecord, decodeCheckpointRecord, isCheckpointRecord } from './storage-record.js';
export { CheckpointRelationCache } from './relation-cache.js';
export type { CheckpointRelationRow } from './relation-cache.js';
