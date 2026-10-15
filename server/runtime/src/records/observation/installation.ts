import type { MemoryEvent, TranscriptEvent } from '@capix/protocol';
import type { InvocationObservationSetup, ObservationInstallation } from '../../binding/observation.js';
import type { ObservationDeclarationScope } from '../../definition/observation.js';
import { ObservationError } from '../../observation/error.js';
import type { EventConsumer, InvocationObserver } from '../../observation/observer.js';
import type { Recorder } from '../recorder.js';
import { RecordingRootHelper } from '../root/helper.js';
import { checkRecordingDeclaration } from './check.js';
import { InvocationRecordAccess } from './declaration.js';
import { InvocationRecording } from './invocation.js';
import { memoryRecord, transcriptRecord } from './mapping.js';

export interface RecordingOptions {
  readonly failure?: 'isolate' | 'propagate';
  readonly invalidate?: (error: unknown) => void;
}

/** One optional record installation. Shared output does not share per-call state. */
export class RecordingInstallation implements ObservationInstallation {
  readonly root;
  readonly provides = Object.freeze({ record: InvocationRecordAccess.request() });
  readonly transcript: EventConsumer<TranscriptEvent> = this.consumer((event) => this.recorder.add(transcriptRecord(event)));
  readonly memory: EventConsumer<MemoryEvent> = this.consumer((event) => this.recorder.add(memoryRecord(event)));
  readonly failure: 'isolate' | 'propagate';
  constructor(
    readonly recorder: Recorder,
    private readonly options: RecordingOptions = {},
  ) {
    this.root = RecordingRootHelper.create(recorder);
    this.failure = options.failure ?? 'isolate';
  }
  check(definition: ObservationDeclarationScope, parent?: ObservationDeclarationScope): void {
    checkRecordingDeclaration(definition, parent, InvocationRecordAccess.request().offer);
  }
  bindInvocation(setup: InvocationObservationSetup, parent?: InvocationObserver): InvocationRecording {
    if (parent && !(parent instanceof InvocationRecording)) throw new Error('Recording parent belongs to another observation capability');
    return new InvocationRecording(this, setup, parent);
  }
  invalidate(error: unknown): void {
    this.options.invalidate?.(error);
  }
  private consumer<Event>(work: (event: Event) => unknown): EventConsumer<Event> {
    let active = true;
    return {
      publish: (event) => {
        if (!active) return undefined;
        try {
          work(event);
          return undefined;
        } catch (cause) {
          active = false;
          const error = new ObservationError(cause);
          this.invalidate(error);
          return this.failure === 'propagate' ? error : undefined;
        }
      },
    };
  }
}

export function bindRecording(recorder: Recorder, options: RecordingOptions = {}): RecordingInstallation {
  return new RecordingInstallation(recorder, options);
}
