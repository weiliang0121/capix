import type { MemoryEvent, TranscriptEvent } from '@capix/protocol';
import type { InvocationObservationSetup, ObservationInstallation } from '../../binding/observation.js';
import type { ObservationDeclarationScope } from '../../definition/observation.js';
import { ObservationError } from '../../observation/error.js';
import type { EventConsumer, InvocationObserver } from '../../observation/observer.js';
import type { Recorder } from '../recorder.js';
import { RecordingRootHelper } from '../root/helper.js';
import { InvocationRecordAccess, invocationRecording, type InvocationRecordDescription } from './declaration.js';
import type { CallableInput, CallableOutput } from '../../definition/signature.js';
import { assertStructureConfigurable } from '../../structure/configuration.js';
import { InvocationRecording } from './invocation.js';
import { memoryRecord, transcriptRecord } from './mapping.js';

export interface RecordingOptions {
  readonly failure?: 'isolate' | 'propagate';
  readonly invalidate?: (error: unknown) => void;
}

/** One optional record installation. Shared output does not share per-call state. */
export class RecordingInstallation implements ObservationInstallation {
  readonly #descriptions = new WeakMap<object, InvocationRecordDescription>();
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
  describe<Structure extends ObservationDeclarationScope>(structure: Structure, description: InvocationRecordDescription<CallableInput<Structure>, CallableOutput<Structure>>): this {
    assertStructureConfigurable(structure);
    if (this.#descriptions.has(structure)) throw new Error('Recording description is already registered for this structure');
    // Only the heterogeneous installation erases the already checked callable signature.
    this.#descriptions.set(structure, description as InvocationRecordDescription);
    return this;
  }
  declarations(structure: ObservationDeclarationScope) {
    return [invocationRecording(this.#descriptions.get(structure))];
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
