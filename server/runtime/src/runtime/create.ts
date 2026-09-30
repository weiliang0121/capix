import type { Message } from '@capix-observer/protocol';
import { RuntimeContext } from '../context/runtime.js';
import { Transcript } from '../transcript/transcript.js';
import { Memories } from '../memory/memories.js';
import { SelectionUsage } from '../transcript/usage.js';
import type { Recorder } from '../records/recorder.js';
import { RuntimeRecordHelper } from '../records/runtime/helper.js';
import { Runtime } from './runtime.js';
import type { ChangeCapture } from '../changes/capture.js';
import type { RuntimeChange } from '@capix-observer/protocol';

/** Assemble a new data scope; this is not an import or recovery entry point. */
export function createRuntime(options: { recorder?: Recorder; messages?: readonly Message[]; changes?: ChangeCapture<RuntimeChange> } = {}): Runtime {
  const transcript = new Transcript(options.messages, { recorder: options.recorder, changes: options.changes });
  const memories = new Memories(transcript, { recorder: options.recorder, changes: options.changes });
  const context = new RuntimeContext(transcript, memories, new SelectionUsage());
  if (!options.recorder) return new Runtime(context, { changes: options.changes });
  const record = RuntimeRecordHelper.create(options.recorder);
  return new Runtime(context, { recording: { recorder: options.recorder, record }, changes: options.changes });
}
