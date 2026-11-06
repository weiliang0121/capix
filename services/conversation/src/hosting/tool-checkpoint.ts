import { RuntimeError } from '@capix/contracts';
import type { CheckpointHead, CheckpointStore } from '@capix/checkpoint';

/** Host read boundary; author facts deliberately do not expose the Frame's order cursor. */
export function readToolCheckpoint(store: Pick<CheckpointStore, 'read'>, contextId: string): CheckpointHead | undefined {
  const head = store.read(contextId);
  if (head?.image.contract.key === 'conversation.tools.archived-answer' && head.image.point === 'prepared') {
    const frame = head.image.frame;
    if (frame.owner.contextId !== contextId || frame.round !== 1 || frame.nextChildOrder !== 0 || frame.children.length !== 0) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'Prepared tool allocation contains prior child activity');
  }
  return head;
}
