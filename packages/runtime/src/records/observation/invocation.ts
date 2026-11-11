import { InvocationResources, RuntimeErrorHelper, failureFact, type InvocationFact, type ResourceObservation, type InvocationObserver } from '@weiliang0121/capix-invocation';
import { isUndefined } from 'es-toolkit/predicate';
import { pick } from 'es-toolkit/object';
import type { ProcessRecord, RecordedRelationChange } from '@weiliang0121/capix-records/data';
import type { InvocationObservationSetup } from '../../binding/observation.js';
import { ResourceSupply, resourceRequests, type ResourceFact } from '@weiliang0121/capix-resources';
import { CallableRecord, InvocationRecordHelper, ResourceRecord, type RecordChangeSource } from '@weiliang0121/capix-records';
import type { RecordWriter } from '@weiliang0121/capix-records/construction';
import { InvocationRecordAccess, type InvocationRecordDescription, type InvocationRecordWriter } from './declaration.js';
import type { RecordingInstallation } from './installation.js';
import { recordedResult } from './mapping.js';

/** A local handle, never registered by Context ID in a global collection. */
export class InvocationRecording implements InvocationObserver {
  readonly resources: InvocationResources<{ record: InvocationRecordWriter }>;
  readonly #childRecordings = new Map<string, InvocationRecording>();
  readonly #pendingAttachments: Extract<InvocationFact, { kind: 'relation' }>[] = [];
  #record?: CallableRecord;
  #startedTick?: number;
  #failed = false;
  readonly #enabled: boolean;
  #recordDescription: InvocationRecordDescription = {};

  constructor(
    private readonly installation: RecordingInstallation,
    readonly setup: InvocationObservationSetup,
    private readonly parentRecording?: InvocationRecording,
  ) {
    this.#enabled = (setup.declarations ?? []).some((declaration) => resourceRequests(declaration.deps).some((request) => request.offer === InvocationRecordAccess.request().offer));
    if (parentRecording && parentRecording.installation !== installation) throw new Error('Recording parent belongs to another installation');
    if (parentRecording) parentRecording.#childRecordings.set(setup.identity.contextId, this);
    this.resources = new InvocationResources({ record: InvocationRecordAccess.request() }, ResourceSupply.capture([InvocationRecordAccess.provide(() => this)], undefined).entries);
  }
  get record(): CallableRecord | undefined {
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
    this.protect((writer) => {
      if (fact.identity.contextId !== this.setup.identity.contextId || fact.identity.kind !== this.setup.identity.kind) throw new Error('Call fact belongs to another local observation');
      this.#recordDescription = description;
      if (fact.kind === 'started') this.begin(fact, writer);
      else if (fact.kind === 'process') this.process(fact, writer);
      else if (fact.kind === 'relation') {
        if (!this.#record && fact.change.kind === 'attached') this.#pendingAttachments.push({ ...fact, identity: { ...fact.identity }, relation: { ...fact.relation }, change: { kind: 'attached' } });
        else this.relation(fact, writer);
      } else this.finish(fact, writer);
    });
  }
  resource(fact: ResourceObservation): void {
    this.protect((writer) => {
      const record = this.requireRecord();
      if (fact.contextId !== record.contextId) throw new Error('Resource fact belongs to another call');
      writer.add(new ResourceRecord({ parentId: record.id, access: fact.access, supplyId: fact.supplyId, sequence: fact.sequence, occurredAt: fact.occurredAt, phase: fact.phase, ...(fact.interactionId ? { interactionId: fact.interactionId } : {}) }, fact.describe()));
    });
  }
  fact(fact: ResourceFact): void {
    this.protect((writer) => {
      if (fact.contextId !== this.setup.identity.contextId) throw new Error('Entity fact belongs to another call');
      this.installation.recordFact(fact, this.source(), writer);
    });
  }
  private requireRecord(): CallableRecord {
    if (!this.#record) throw new Error('The call recording has not started');
    return this.#record;
  }
  private source(): RecordChangeSource {
    const record = this.requireRecord();
    return { contextId: record.contextId, callId: record.id };
  }
  private begin(fact: Extract<InvocationFact, { kind: 'started' }>, writer: RecordWriter): void {
    if (this.#record) throw new Error('A call recording can only start once');
    const input = this.#recordDescription.input ? this.#recordDescription.input(fact.input) : fact.input;
    const description = fact.description ?? this.setup.description ?? {};
    const parentRecord = this.parentRecording?.requireRecord();
    if ((fact.identity.parentContextId !== undefined) !== !!parentRecord || (parentRecord && parentRecord.contextId !== fact.identity.parentContextId)) throw new Error('Call recording parent differs from its invocation relationship');
    this.#record = writer.add(
      new CallableRecord(
        {
          contextId: fact.identity.contextId,
          structureKind: fact.identity.kind,
          parentId: parentRecord?.id ?? this.installation.root.id,
          ...(description.id !== undefined ? { structureId: description.id } : {}),
          ...pick(description, ['name', 'label', 'source']),
          ...(this.#recordDescription.role !== undefined || description.role !== undefined ? { role: this.#recordDescription.role ?? description.role } : {}),
        },
        { input, startedAt: fact.occurredAt },
      ),
    );
    this.#startedTick = fact.monotonicTime;
    this.boundary(fact, 'call', writer);
    // Construction can attach children before this call starts; retain actual fact order.
    for (const attachment of this.#pendingAttachments.splice(0)) this.relation(attachment, writer, Math.max(0, this.offset(attachment.monotonicTime)));
  }
  private process(fact: Extract<InvocationFact, { kind: 'process' }>, writer: RecordWriter): void {
    const record = this.requireRecord();
    const process = fact.process;
    let body;
    if ('error' in process) body = { ...process, error: RuntimeErrorHelper.format(process.error), ...(process.failure ? { failure: failureFact(process.failure) } : {}) };
    else if ('input' in process && this.#recordDescription.input) body = { ...process, input: this.#recordDescription.input(process.input) };
    else if ('output' in process && this.#recordDescription.output) body = { ...process, output: this.#recordDescription.output(process.output) };
    else body = process;
    const entry: ProcessRecord = { ...body, sequence: fact.processSequence, eventSequence: fact.eventSequence, round: fact.round, occurredAt: fact.occurredAt, offsetMs: this.offset(fact.monotonicTime) };
    writer.update(
      record,
      (current) => current.append(entry),
      (current) => ({ kind: 'process-appended', id: current.id, process: current.value.processes.at(-1)! }),
    );
  }
  private relation(fact: Extract<InvocationFact, { kind: 'relation' }>, writer: RecordWriter, offsetMs = this.offset(fact.monotonicTime)): void {
    const record = this.requireRecord();
    const childRecording = this.#childRecordings.get(fact.relation.childContextId);
    if (fact.relation.parentContextId !== record.contextId) throw new Error('Relation fact belongs to another parent');
    let change: RecordedRelationChange;
    if (fact.change.kind === 'returned') change = { kind: 'returned', result: recordedResult(fact.change.result, childRecording ? childRecording.#recordDescription : undefined) };
    else if (fact.change.kind === 'accepted' && this.#recordDescription.relationAccepted) change = { kind: 'accepted', output: this.#recordDescription.relationAccepted(fact.change.output, fact.relation) };
    else if (fact.change.kind === 'handled' && this.#recordDescription.relationHandled) change = { kind: 'handled', output: this.#recordDescription.relationHandled(fact.change.output, fact.relation) };
    else if (fact.change.kind === 'failed') change = { kind: 'failed', source: fact.change.source, error: RuntimeErrorHelper.format(fact.change.error), ...(fact.change.failure ? { failure: failureFact(fact.change.failure) } : {}) };
    else change = fact.change;
    const relation = { identity: fact.relation, eventSequence: fact.eventSequence, occurredAt: fact.occurredAt, offsetMs, ...(childRecording?.record ? { childId: childRecording.record.id } : {}), change };
    writer.update(
      record,
      (current) => current.appendRelation(relation),
      (current) => ({ kind: 'relation-appended', id: current.id, relation: current.value.relationChanges.at(-1)! }),
    );
  }
  private finish(fact: Extract<InvocationFact, { kind: 'finished' }>, writer: RecordWriter): void {
    const state = fact.state;
    if (!this.#record && state.status === 'failed') return;
    const record = this.requireRecord();
    if (state.status === 'running') throw new Error('A terminal call fact requires an outcome');
    if (state.status === 'failed') InvocationRecordHelper.finish(writer, record, (current) => current.fail(RuntimeErrorHelper.format(state.error), state.failure ? failureFact(state.failure) : undefined));
    else {
      const last = record.value.processes.at(-1);
      const resultOf = last?.type === 'return' ? ('resultOf' in last ? last.resultOf : last.sequence) : undefined;
      const output = isUndefined(resultOf) ? (this.#recordDescription.output ? this.#recordDescription.output(state.output) : state.output) : undefined;
      InvocationRecordHelper.finish(writer, record, (current) => current.complete(output, resultOf));
    }
    this.boundary(fact, state.status === 'succeeded' ? 'return' : 'throw', writer);
  }
  private timingRoot(): InvocationRecording {
    let recording: InvocationRecording = this;
    while (recording.parentRecording) recording = recording.parentRecording;
    return recording;
  }
  private offset(time: number): number {
    const timingRecording = this.timingRoot();
    if (isUndefined(timingRecording.#startedTick)) throw new Error('Call recording has no timing origin');
    return time - timingRecording.#startedTick;
  }
  private boundary(fact: InvocationFact, type: 'call' | 'return' | 'throw', writer: RecordWriter): void {
    const timingRecording = this.timingRoot();
    writer.boundary({ start: timingRecording.#startedTick!, scopeId: timingRecording.requireRecord().id, callId: this.requireRecord().id, occurredAt: fact.occurredAt, offsetMs: this.offset(fact.monotonicTime) }, type);
  }
  private protect(work: (writer: RecordWriter) => void): void {
    if (!this.available()) return;
    try {
      // Observation owns this window, not the ending business call. No observer is
      // attached to it: recording a fact must not recursively record its own write.
      const access = this.installation.records.open();
      try {
        work(access.endpoints.record);
      } finally {
        access.close();
      }
    } catch (error) {
      this.#failed = true;
      this.installation.invalidate(error);
      throw error;
    }
  }
}
