import type { CheckpointPublication, CheckpointHead } from './contract.js';

const publications = new WeakMap<CheckpointHead, CheckpointPublication>();

/** Only an exact, fully authenticated read result carries this local publication basis. */
export function checkpointHeadCommit(head: CheckpointHead): CheckpointPublication | undefined {
  return publications.get(head);
}

/** Package-internal: never exported by either public package entry. */
export function rememberCheckpointHead(head: CheckpointHead, commit: CheckpointPublication): void {
  publications.set(head, commit);
}
