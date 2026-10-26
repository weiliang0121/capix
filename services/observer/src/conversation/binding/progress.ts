import type { InvocationProgress } from '@capix/server-runtime';
import type { ProgressChannel, ProgressReceiver } from '@capix/changes';
import type { InvocationOutputReceiver } from '@capix/structure';
import type { TranscriptAppendProgress } from '@capix/transcript';
import type { ConversationTask, GenerationOutput } from '@capix/protocol';
import type { FileProgress } from '../../files/index.js';
import type { ConversationProgress } from '../progress.js';
import type { AnswerProgress } from '../group/answer/stream.js';

export function taskProgress(progress?: ProgressChannel<ConversationProgress>, files?: ProgressChannel<FileProgress>): ProgressReceiver<ConversationTask> {
  return {
    receive(task): undefined {
      progress?.publish({ kind: 'task', task });
      if (task.kind === 'file' && task.task.output) files?.publish({ kind: 'requested', path: task.task.output.path });
    },
  };
}

export function messageProgress(kind: 'input' | 'answer', progress?: ProgressChannel<ConversationProgress>, capture?: (range: TranscriptAppendProgress) => void): ProgressReceiver<TranscriptAppendProgress> | undefined {
  if (!progress && !capture) return;
  return {
    receive(range): undefined {
      capture?.(range);
      progress?.publish({ kind, range });
    },
  };
}

export function activityProgress(progress?: ProgressChannel<InvocationProgress>): ProgressReceiver<InvocationProgress> | undefined {
  if (!progress) return;
  return {
    receive(fact): undefined {
      progress.publish(fact);
    },
  };
}

export function answerProgress(progress?: ProgressChannel<AnswerProgress>): InvocationOutputReceiver<GenerationOutput, AnswerProgress> | undefined {
  if (!progress) return;
  return {
    receive(event): undefined {
      if (event.kind === 'delta') progress.publish(event.delta);
    },
  };
}
