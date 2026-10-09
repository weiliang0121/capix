import { RuntimeContext } from '../context/runtime.js';
import type { Recorder } from '../records/recorder.js';
import { RuntimeRecordHelper } from '../records/runtime/helper.js';
import { Runtime, type RuntimeEntry } from './runtime.js';
import type { ChangeCapture } from '../changes/capture.js';
import type { InvocationEvent } from '@capix-observer/protocol';
import type { ExecutionOptions } from '../context/execution.js';

export interface RuntimeCreationOptions {
  recorder?: Recorder;
  changes?: ChangeCapture<InvocationEvent>;
}

/** Establish only R's context and optional record; content entities are assembled independently. */
export function createRuntime<I = unknown, O = unknown, P extends ExecutionOptions = ExecutionOptions>(options: RuntimeCreationOptions = {}, assemble?: (runtime: Runtime<I, O, P>) => RuntimeEntry<I, O, P>): Runtime<I, O, P> {
  const context = new RuntimeContext();
  const recording = options.recorder ? { recorder: options.recorder, record: RuntimeRecordHelper.create(options.recorder) } : undefined;
  return new Runtime(context, { recording, changes: options.changes }, assemble);
}
