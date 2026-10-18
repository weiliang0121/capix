import { ActiveContent } from '@capix/observer-service';
import { Transcript, Memories, SelectionUsage } from '@capix/server-runtime';
import { createBoundRuntime } from './runtime.mjs';

/** Test assembly owns entities independently from the runtime under test. */
export function createEnvironment(options = {}) {
  const { messages = [], recorder, changes } = options;
  const runtime = createBoundRuntime({ recorder, changes });
  const transcript = new Transcript(messages, { observation: runtime.recording?.transcript, changes });
  const memories = new Memories(transcript, { observation: runtime.recording?.memory, changes });
  const selectionUsage = new SelectionUsage();
  return { runtime, transcript, memories, selectionUsage, active: new ActiveContent(transcript, memories) };
}
