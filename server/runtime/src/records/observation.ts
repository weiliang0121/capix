import { isUndefined } from 'es-toolkit/predicate';
import { pick } from 'es-toolkit/object';
import type { MemoryEvent, TranscriptEvent, ProcessRecord, RecordedInvocationResult, RecordedRelationChange, InvocationOrigin, InvocationRelationIdentity } from '@capix/protocol';
import type { EventConsumer, InvocationObserver } from '../observation/observer.js';
import type { InvocationObservationSetup, ObservationInstallation } from '../binding/observation.js';
import type { ObservationDeclarationScope } from '../definition/observation.js';
import type { InvocationFact, ResourceObservation } from '../observation/facts.js';
import { ObservationError } from '../observation/error.js';
import { defineObservation } from '../definition/observation.js';
import { ResourceOffer } from '../resource/offer.js';
import { bindResources, resourceRequests, type ResourceBindings } from '../resource/bindings.js';
import { RuntimeErrorHelper } from '../errors/helper.js';
import { failureFact } from '../invocation/failure.js';
import type { InvocationResult } from '../invocation/result.js';
import { Recorder } from './recorder.js';
import type { ConcreteInvocationRecord } from './invocation/record.js';
import { InvocationRecordHelper } from './invocation/helper.js';
import { InvocationBoundaryRecordHelper } from './invocation-boundary/helper.js';
import { RecordingRootHelper } from './root/helper.js';
import { RuntimeCallRecord } from './runtime-call/record.js';
import { ExecutionRecord } from './execution/record.js';
import { OperationRecord } from './operation/record.js';
import { AttemptRecord } from './attempt/record.js';
import { ResourceRecord } from './resource/record.js';
import { TranscriptRecord } from './transcript/record.js';
import { MemoryRecord } from './memory/record.js';
import type { RecordChangeSource } from './source.js';
import { checkRecordingDeclaration } from './observation-check.js';

export interface InvocationRecordDescription<Input = unknown, Output = unknown> {
  readonly input?: (input: Input) => unknown;
  readonly output?: (output: Output) => unknown;
  /** Parent acceptance may produce a different value from the child's returned output. */
  readonly relationAccepted?: (output: unknown, relation: InvocationRelationIdentity) => unknown;
}
export interface InvocationRecordWriter {
  observe(fact: InvocationFact, description?: InvocationRecordDescription): undefined;
}

/** Only observation declarations may request this locally supplied writer. */
export const InvocationRecordAccess = new ResourceOffer<InvocationRecording, InvocationRecordWriter>('observation.call-record', (recording, activity) =>
  Object.freeze({
    observe(fact: InvocationFact, description?: InvocationRecordDescription): undefined {
      activity.validate();
      recording.observeDescribed(fact, description);
      return undefined;
    },
  }),
);

/** Call records are produced here, not by an implicit Invocation recording path. */
export function invocationRecording<Input = unknown, Output = unknown>(description: InvocationRecordDescription<Input, Output> = {}, options: { failure?: 'isolate' | 'propagate' } = {}) {
  const mapped: InvocationRecordDescription = {
    ...(description.input ? { input: (input: unknown) => description.input!(input as Input) } : {}),
    ...(description.output ? { output: (output: unknown) => description.output!(output as Output) } : {}),
    ...(description.relationAccepted ? { relationAccepted: description.relationAccepted } : {}),
  };
  return defineObservation<InvocationFact, { record: InvocationRecordWriter }>(
    {
      requires: { record: InvocationRecordAccess.request() },
      observe(fact, ports) {
        return ports.record.observe(fact, mapped);
      },
    },
    options,
  );
}

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

/** A local handle, never registered by Context ID in a global collection. */
export class InvocationRecording implements InvocationObserver {
  readonly resources: ResourceBindings<{ record: InvocationRecordWriter }>;
  readonly #childRecordings = new Map<string, InvocationRecording>();
  readonly #pendingAttachments: Extract<InvocationFact, { kind: 'relation' }>[] = [];
  #record?: ConcreteInvocationRecord;
  #startedTick?: number;
  #failed = false;
  readonly #enabled: boolean;
  #recordDescription: InvocationRecordDescription = {};
  #executionRecording?: InvocationRecording;

  constructor(
    private readonly installation: RecordingInstallation,
    readonly setup: InvocationObservationSetup,
    private readonly parentRecording?: InvocationRecording,
  ) {
    this.#enabled = (setup.declarations ?? []).some((declaration) => resourceRequests(declaration.requires).some((request) => request.offer === InvocationRecordAccess.request().offer));
    if (parentRecording && parentRecording.installation !== installation) throw new Error('Recording parent belongs to another installation');
    if (parentRecording) parentRecording.#childRecordings.set(setup.identity.contextId, this);
    this.resources = bindResources({ record: InvocationRecordAccess.request() }, [InvocationRecordAccess.provide(() => this)])(undefined);
  }
  get record(): ConcreteInvocationRecord | undefined {
    return this.#record;
  }
  available(): boolean {
    return this.#enabled && !this.#failed && (this.parentRecording?.available() ?? true);
  }
  /** Call production belongs exclusively to the requested writer declaration. */
  observe(_fact: InvocationFact): undefined {
    return undefined;
  }
  observeDescribed(fact: InvocationFact, description: InvocationRecordDescription = {}): void {
    this.protect(() => {
      if (fact.identity.contextId !== this.setup.identity.contextId || fact.identity.level !== this.setup.identity.level) throw new Error('Call fact belongs to another local observation');
      this.#recordDescription = description;
      if (fact.kind === 'started') this.begin(fact);
      else if (fact.kind === 'process') this.process(fact);
      else if (fact.kind === 'relation') {
        if (!this.#record && fact.change.kind === 'attached') this.#pendingAttachments.push({ ...fact, identity: { ...fact.identity }, relation: { ...fact.relation }, change: { kind: 'attached' } });
        else this.relation(fact);
      } else if (fact.kind === 'entry') return;
      else this.finish(fact);
    });
  }
  resource(fact: ResourceObservation): void {
    this.protect(() => {
      const record = this.requireRecord();
      if (fact.contextId !== record.contextId) throw new Error('Resource fact belongs to another call');
      this.recorder.add(new ResourceRecord({ parentId: record.id, access: fact.access, supplyId: fact.supplyId, sequence: fact.sequence, occurredAt: fact.occurredAt, phase: fact.phase, ...(fact.interactionId ? { interactionId: fact.interactionId } : {}) }, fact.describe()));
    });
  }
  transcript(event: TranscriptEvent): void {
    this.protect(() => {
      this.checkOrigin(event.origin);
      this.recorder.add(transcriptRecord(event, this.source()));
    });
  }
  memory(event: MemoryEvent): void {
    this.protect(() => {
      this.checkOrigin(event.origin);
      this.recorder.add(memoryRecord(event, this.source()));
    });
  }
  private get recorder(): Recorder {
    return this.installation.recorder;
  }
  private requireRecord(): ConcreteInvocationRecord {
    if (!this.#record) throw new Error('The call recording has not started');
    return this.#record;
  }
  private checkOrigin(origin?: InvocationOrigin): void {
    if (origin?.contextId !== this.setup.identity.contextId) throw new Error('Entity fact belongs to another call');
  }
  private source(): RecordChangeSource {
    const record = this.requireRecord();
    const executionRecord = this.#executionRecording ? this.#executionRecording.#record : undefined;
    return { contextId: record.contextId, callId: record.id, ...(executionRecord ? { executionId: executionRecord.id } : {}), ...(record instanceof OperationRecord ? { operationId: record.id } : record instanceof AttemptRecord ? { operationId: record.operationId } : {}) };
  }
  private begin(fact: Extract<InvocationFact, { kind: 'started' }>): void {
    if (this.#record) throw new Error('A call recording can only start once');
    const input = this.#recordDescription.input ? this.#recordDescription.input(fact.input) : fact.input;
    const description = pick(fact.description ?? this.setup.description ?? {}, ['id', 'name', 'label', 'source', 'callee']);
    const parentRecord = this.parentRecording?.requireRecord();
    const contextId = fact.identity.contextId;
    if (fact.identity.level === 'runtime') {
      if (parentRecord || !description?.id) throw new Error('Runtime recording requires a stable Runtime instance identity');
      this.#record = this.recorder.add(new RuntimeCallRecord(contextId, description.id, { input, startedAt: fact.occurredAt }, this.installation.root.id));
    } else if (fact.identity.level === 'execution') {
      if (!(parentRecord instanceof RuntimeCallRecord)) throw new Error('Execution recording requires its parent Runtime call');
      this.#record = this.recorder.add(new ExecutionRecord(contextId, { input, startedAt: fact.occurredAt }, parentRecord.id));
      this.#executionRecording = this;
    } else if (fact.identity.level === 'operation') {
      if (!(parentRecord instanceof ExecutionRecord || parentRecord instanceof OperationRecord) || !description?.id || !description.name || !description.label || isUndefined(description.source)) throw new Error('Operation recording requires a parent record and a complete description');
      this.#executionRecording = this.parentRecording ? this.parentRecording.#executionRecording : undefined;
      this.#record = this.recorder.add(new OperationRecord({ contextId, executionId: parentRecord instanceof ExecutionRecord ? parentRecord.id : parentRecord.executionId, operationInstanceId: description.id, operation: description.name, label: description.label, source: description.source, caller: parentRecord instanceof ExecutionRecord ? 'execution' : 'operation', callee: 'operation', ...(parentRecord instanceof OperationRecord ? { parentOperationId: parentRecord.id } : {}) }, input));
    } else {
      if (!(parentRecord instanceof OperationRecord) || !description?.name || !description.label || isUndefined(description.source) || !description.callee) throw new Error('Attempt recording requires a parent record and a complete description');
      this.#executionRecording = this.parentRecording ? this.parentRecording.#executionRecording : undefined;
      this.#record = this.recorder.add(new AttemptRecord({ contextId, operationId: parentRecord.id, name: description.name, label: description.label, source: description.source, caller: 'operation', callee: description.callee }, input));
    }
    this.#startedTick = fact.monotonicTime;
    this.boundary(fact, 'call');
    // Construction can attach children before this call starts; retain the actual fact order.
    for (const attachment of this.#pendingAttachments.splice(0)) this.relation(attachment, Math.max(0, this.offset(attachment.monotonicTime)));
  }
  private process(fact: Extract<InvocationFact, { kind: 'process' }>): void {
    const record = this.requireRecord();
    const process = fact.process;
    let body;
    if ('reuse' in process) {
      const previous = record.value.processes.at(-1);
      if (!previous || previous.stage !== 'execute' || previous.type !== 'return' || previous.round !== fact.round) throw new Error('Default acceptance must follow its execution result');
      body = { stage: 'receive' as const, type: 'return' as const, resultOf: previous.sequence };
    } else if ('error' in process) body = { ...process, error: RuntimeErrorHelper.format(process.error), ...(process.failure ? { failure: failureFact(process.failure) } : {}) };
    else if ('input' in process && this.#recordDescription.input) body = { ...process, input: this.#recordDescription.input(process.input) };
    else if ('output' in process && this.#recordDescription.output) body = { ...process, output: this.#recordDescription.output(process.output) };
    else body = process;
    const entry: ProcessRecord = { ...body, sequence: fact.processSequence, eventSequence: fact.eventSequence, round: fact.round, occurredAt: fact.occurredAt, offsetMs: this.offset(fact.monotonicTime) };
    this.recorder.update(
      record,
      (current) => current.append(entry),
      (current) => ({ kind: 'process-appended', id: current.id, process: current.value.processes.at(-1)! }),
    );
  }
  private relation(fact: Extract<InvocationFact, { kind: 'relation' }>, offsetMs = this.offset(fact.monotonicTime)): void {
    const record = this.requireRecord();
    const childRecording = this.#childRecordings.get(fact.relation.childContextId);
    if (fact.relation.parentContextId !== record.contextId) throw new Error('Relation fact belongs to another parent');
    let change: RecordedRelationChange;
    if (fact.change.kind === 'returned') change = { kind: 'returned', result: recordedResult(fact.change.result, childRecording ? childRecording.#recordDescription : undefined) };
    else if (fact.change.kind === 'accepted' && this.#recordDescription.relationAccepted) change = { kind: 'accepted', output: this.#recordDescription.relationAccepted(fact.change.output, fact.relation) };
    else if (fact.change.kind === 'failed') change = { kind: 'failed', source: fact.change.source, error: RuntimeErrorHelper.format(fact.change.error), ...(fact.change.failure ? { failure: failureFact(fact.change.failure) } : {}) };
    else change = fact.change;
    const relation = { identity: fact.relation, eventSequence: fact.eventSequence, occurredAt: fact.occurredAt, offsetMs, ...(childRecording?.record ? { childId: childRecording.record.id } : {}), change };
    this.recorder.update(
      record,
      (current) => current.appendRelation(relation),
      (current) => ({ kind: 'relation-appended', id: current.id, relation: current.value.relationChanges.at(-1)! }),
    );
  }
  private finish(fact: Extract<InvocationFact, { kind: 'finished' }>): void {
    const state = fact.state;
    if (!this.#record && state.status === 'failed') return;
    const record = this.requireRecord();
    if (state.status === 'running') throw new Error('A terminal call fact requires an outcome');
    if (state.status === 'failed') InvocationRecordHelper.finish(this.recorder, record, (current) => current.fail(RuntimeErrorHelper.format(state.error), state.failure ? failureFact(state.failure) : undefined));
    else {
      const last = record.value.processes.at(-1);
      const resultOf = (last?.stage === 'receive' || last?.stage === 'handling') && last.type === 'return' ? ('resultOf' in last ? last.resultOf : last.sequence) : undefined;
      const output = isUndefined(resultOf) ? (this.#recordDescription.output ? this.#recordDescription.output(state.output) : state.output) : undefined;
      InvocationRecordHelper.finish(this.recorder, record, (current) => current.complete(output, resultOf));
    }
    this.boundary(fact, state.status === 'succeeded' ? 'return' : 'throw');
  }
  private offset(time: number): number {
    const timingRecording = this.#executionRecording ?? this;
    if (isUndefined(timingRecording.#startedTick)) throw new Error('Call recording has no timing origin');
    return time - timingRecording.#startedTick;
  }
  private boundary(fact: InvocationFact, type: 'call' | 'return' | 'throw'): void {
    const timingRecording = this.#executionRecording ?? this;
    InvocationBoundaryRecordHelper.create(this.recorder, { start: timingRecording.#startedTick!, scopeId: timingRecording.requireRecord().id, callId: this.requireRecord().id, occurredAt: fact.occurredAt, offsetMs: this.offset(fact.monotonicTime) }, type);
  }
  private protect(work: () => void): void {
    if (!this.available()) return;
    try {
      work();
    } catch (error) {
      this.#failed = true;
      this.installation.invalidate(error);
      throw error;
    }
  }
}

function recordedResult(result: InvocationResult<unknown>, description?: InvocationRecordDescription): RecordedInvocationResult {
  if (result.status === 'succeeded') return { status: 'succeeded', output: description?.output ? description.output(result.output) : result.output };
  return { status: 'failed', error: RuntimeErrorHelper.format(result.error), ...(result.failure ? { failure: failureFact(result.failure) } : {}) };
}
function transcriptRecord(event: TranscriptEvent, source?: RecordChangeSource): TranscriptRecord {
  const change = event.change;
  return new TranscriptRecord({ transcriptId: event.transcriptId, revision: event.revision, occurredAt: event.occurredAt, ...(source ? { source } : {}) }, change.kind === 'messages-appended' ? { action: 'append', start: change.start, end: change.start + change.messages.length } : { action: 'segment', previousStart: change.previousStart, start: change.start, end: change.end });
}
function memoryRecord(event: MemoryEvent, source?: RecordChangeSource): MemoryRecord {
  return new MemoryRecord({ memoriesId: event.memoriesId, memoryId: event.change.memoryId, sequence: event.sequence, ...(source ? { source } : {}) }, { action: event.change.action, change: event.change.explanation, sourceIndexes: event.change.sourceIndexes, ...(event.change.sourceResults ? { sourceResults: event.change.sourceResults } : {}), result: event.change.result });
}
