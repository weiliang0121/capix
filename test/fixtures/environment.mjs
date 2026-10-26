import { ActiveView } from '@capix/view';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { MessageUsage } from '@capix/measurement';
import { createBoundRuntime } from './runtime.mjs';

/** Test assembly owns entities independently from the runtime under test. */
export function createEnvironment(options = {}) {
  const { messages = [], recorder, changes } = options;
  const runtime = createBoundRuntime({ recorder, changes });
  const transcript = new Transcript(messages, { observation: runtime.recording?.transcript, changes });
  const memories = new Memories(transcript, { observation: runtime.recording?.memory, changes });
  const messageUsage = new MessageUsage();
  return { runtime, transcript, memories, messageUsage, active: new ActiveView(transcript, memories) };
}
