import type { Message } from '@capix-observer/protocol';
import { RuntimeContext } from '../context/runtime.js';
import { Transcript } from '../transcript/transcript.js';
import { Memories } from '../memory/memories.js';
import { SelectionUsage } from '../transcript/usage.js';
import type { Recorder } from '../records/recorder.js';
import { RuntimeRecordHelper } from '../records/runtime/helper.js';
import { Runtime } from './runtime.js';

/** Assemble a new data scope; this is not an import or recovery entry point. */
export function createRuntime(options: { recorder?: Recorder; messages?: readonly Message[] } = {}): Runtime {
  const transcript = new Transcript(options.messages, options.recorder);
  const memories = new Memories(transcript, options.recorder);
  const context = new RuntimeContext(transcript, memories, new SelectionUsage());
  if (!options.recorder) return new Runtime(context);
  const record = RuntimeRecordHelper.create(options.recorder);
  return new Runtime(context, { recorder: options.recorder, record });
}
