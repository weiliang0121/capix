import type { ConversationTask } from '@capix/protocol';
import { ResourceOffer, ProgressChannel, type ProgressReceiver } from '@capix/server-runtime';

export interface TaskSelection {
  select(task: ConversationTask): void;
}

/** A per-execution service decision port. Delivery consumes the fact; it does not choose work. */
export const ConversationTaskResource = new ResourceOffer<{ readonly progress?: ProgressReceiver<ConversationTask> }, TaskSelection>({
  name: 'conversation.task-selection',
  expose: ({ progress }, activity) => {
    let selected = false;
    const changes = progress ? new ProgressChannel(progress) : undefined;
    return Object.freeze({
      select(task: ConversationTask): void {
        activity.runSync('select', { input: () => task }, () => {
          if (selected) throw new Error('The conversation task has already been selected');
          selected = true;
          changes?.publish(task);
        });
      },
    });
  },
  timing: 'access',
});
