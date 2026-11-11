import { Transcript } from '@weiliang0121/capix-transcript';
import { Memories } from '@weiliang0121/capix-memory';
import { MessageUsage } from '@weiliang0121/capix-measurement';
import { createBoundRuntime } from './runtime.mjs';

/** Test assembly owns entities independently from the runtime under test. */
export function createEnvironment(options = {}) {
  const { messages = [], recorder, changes } = options;
  const runtime = createBoundRuntime({ recorder, changes });
  const transcript = new Transcript(messages, { observation: runtime.recording?.transcript, changes });
  const memories = new Memories({ observation: runtime.recording?.memory, changes });
  const messageUsage = new MessageUsage();
  return { runtime, transcript, memories, messageUsage };
}
