import { createRuntime, Transcript, Memories, SelectionUsage } from '@capix-observer/runtime';

/** Test assembly owns entities independently from the runtime under test. */
export function createEnvironment(options = {}) {
  const { messages = [], recorder, changes } = options;
  const transcript = new Transcript(messages, { recorder, changes });
  const memories = new Memories(transcript, { recorder, changes });
  const selectionUsage = new SelectionUsage();
  const runtime = createRuntime({ recorder, changes });
  return { runtime, transcript, memories, selectionUsage };
}
