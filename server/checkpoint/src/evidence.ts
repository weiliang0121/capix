import type { CheckpointCommit, CheckpointHead } from './contract.js';

const publications = new WeakMap<CheckpointHead, CheckpointCommit>();

/** Only an exact, fully authenticated read result carries this local publication basis. */
export function checkpointHeadCommit(head: CheckpointHead): CheckpointCommit | undefined {
  return publications.get(head);
}

/** Package-internal: never exported by either public package entry. */
export function rememberCheckpointHead(head: CheckpointHead, commit: CheckpointCommit): void {
  publications.set(head, commit);
}
