import type { MemoryEvent, TranscriptEvent } from '@capix/protocol';
import type { InvocationObservationSetup, ObservationInstallation } from '../../binding/observation.js';
import type { ObservationDeclarationScope } from '../../definition/observation.js';
import { ObservationError, type InvocationObserver } from '@capix/invocation';
import type { EventConsumer } from '@capix/changes';
import type { Recorder, RecordingRootRecord } from '@capix/records';
import { RecordWriterResource, type RecordWriter } from '@capix/records/construction';
import { Resource, Resources, type ResourceBinding } from '@capix/resources';
import { InvocationRecordAccess, invocationRecording, type InvocationRecordDescription } from './declaration.js';
import type { CallableInput, CallableOutput } from '@capix/contracts';
import { assertStructureConfigurable } from '@capix/structure/construction';
import { InvocationRecording } from './invocation.js';
import { memoryRecord, transcriptRecord } from './mapping.js';

export interface RecordingOptions {
  readonly failure?: 'isolate' | 'propagate';
  readonly invalidate?: (error: unknown) => void;
}

/** One optional record installation. Shared output does not share per-call state. */
export class RecordingInstallation implements ObservationInstallation {
  readonly #descriptions = new WeakMap<object, InvocationRecordDescription>();
  readonly root: RecordingRootRecord;
  /** Fixed entity supply; each observed fact opens its own synchronous window. */
  readonly records: ResourceBinding<{ record: RecordWriter }>;
  readonly provides = Object.freeze({ record: InvocationRecordAccess.request() });
  readonly transcript: EventConsumer<TranscriptEvent> = this.consumer((event, writer) => writer.add(transcriptRecord(event)));
  readonly memory: EventConsumer<MemoryEvent> = this.consumer((event, writer) => writer.add(memoryRecord(event)));
  readonly failure: 'isolate' | 'propagate';
  constructor(
    readonly recorder: Recorder,
    private readonly options: RecordingOptions = {},
  ) {
    this.records = new Resources().register(new Resource(recorder), RecordWriterResource).bind({ record: RecordWriterResource.request() });
    const access = this.records.open();
    try {
      this.root = access.endpoints.record.root();
    } finally {
      access.close();
    }
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
  private consumer<Event>(work: (event: Event, writer: RecordWriter) => unknown): EventConsumer<Event> {
    let active = true;
    return {
      publish: (event) => {
        if (!active) return undefined;
        try {
          const access = this.records.open();
          try {
            work(event, access.endpoints.record);
          } finally {
            access.close();
          }
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
