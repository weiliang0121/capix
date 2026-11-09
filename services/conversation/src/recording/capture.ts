import { RecordBook, Recorder } from '@weiliang0121/capix-records';
import type { ConversationRecordingState, ConversationInspection, ConversationCallDetail, MemoryEvent, TranscriptEvent } from '@weiliang0121/capix-protocol';
import type { CallableStructure, Composite } from '@weiliang0121/capix-structure';
import type { DriverFact, DriverObserver, InvocationFact, InvocationObserver, InvocationObservationSetup, ObservationDeclarationScope, ObservationInstallation, ResourceObservation } from '@weiliang0121/capix-runtime';
import { bindRecording, invocationRecording, InvocationRecordAccess, type InvocationRecording } from '@weiliang0121/capix-runtime/recording';
import type { ConversationViewSource } from '../materials/view.js';
import { conversationRecordDescription } from './installation.js';
import { inspectConversation, inspectConversationCall, inspectConversationContent } from './inspection.js';

const disabled: InvocationObserver = Object.freeze({ available: () => false, observe: () => undefined });

/** Host-owned capture control. Membership is fixed once per Scene entry, never per fact. */
export class ConversationRecording implements ObservationInstallation {
  readonly failure = 'isolate';
  readonly provides = Object.freeze({ record: InvocationRecordAccess.request() });
  #capture?: Capture;
  #driverId?: string;
  // Keep off entries too: enabling during a live call cannot capture its later children.
  // Released feedback can reenter Runner before the installation receives released;
  // acquisition order, rather than a mutable "current" handle, pairs these facts.
  readonly #entries: { readonly capture?: Capture }[] = [];

  constructor(private readonly scene: CallableStructure<'scene'> & Composite) {}

  state(): ConversationRecordingState {
    const capture = this.#capture;
    return capture ? Object.freeze({ status: capture.status, recorderId: capture.recorder.id }) : Object.freeze({ status: 'idle' });
  }

  start(): ConversationRecordingState {
    if (this.#capture && this.#capture.status !== 'recording') throw new Error('Clear the previous recording before starting another capture');
    this.#capture ??= new Capture();
    return this.state();
  }

  stop(): ConversationRecordingState {
    const capture = this.#capture;
    if (capture?.status === 'recording') capture.status = capture.entries > 0 ? 'stopping' : 'stopped';
    return this.state();
  }

  clear(): ConversationRecordingState {
    if (this.#capture && this.#capture.status !== 'stopped') throw new Error('Stop recording and wait for captured calls to finish before clearing it');
    this.#capture = undefined;
    return this.state();
  }

  inspect(content: ConversationViewSource): ConversationInspection {
    const capture = this.#capture;
    return capture ? inspectConversation(content, capture.recorder, capture.installation.root, capture.integrity, capture.status) : inspectConversationContent(content, { status: 'idle', revision: 0, integrity: 'intact', calls: [], omitted: 0 });
  }

  call(id: string): ConversationCallDetail | undefined {
    const capture = this.#capture;
    return capture ? inspectConversationCall(capture.recorder, capture.installation.root, id, capture.integrity) : undefined;
  }

  declarations(structure: ObservationDeclarationScope) {
    return [invocationRecording(conversationRecordDescription(structure === this.scene))];
  }

  check(structure: ObservationDeclarationScope, parent?: ObservationDeclarationScope): void {
    if (!parent && structure !== this.scene) throw new Error('Recording must be installed on its configured Scene');
  }

  bindDriver(identity: Readonly<{ driverId: string }>): DriverObserver {
    if (this.#driverId !== undefined) throw new Error('A recording controller belongs to one Runner');
    this.#driverId = identity.driverId;
    return { observe: (fact) => this.entry(fact) };
  }

  bindInvocation(setup: InvocationObservationSetup, parent?: InvocationObserver): InvocationObserver {
    if (parent && (!(parent instanceof CapturedInvocation) || parent.owner !== this)) throw new Error('Recording parent belongs to another capture controller');
    const previous = parent instanceof CapturedInvocation ? parent : undefined;
    const capture = previous?.capture ?? this.#entries.at(-1)?.capture;
    if (!capture) return disabled;
    return new CapturedInvocation(this, capture, capture.installation.bindInvocation(setup, previous?.recording));
  }

  invalidate(): void {
    const capture = this.#entries.at(-1)?.capture;
    if (capture) capture.integrity = 'incomplete';
  }

  private entry(fact: DriverFact): undefined {
    if (fact.kind === 'established' || fact.boundId !== this.scene.id) return undefined;
    if (fact.kind === 'acquired') {
      const capture = this.#capture?.status === 'recording' ? this.#capture : undefined;
      if (capture) capture.entries++;
      this.#entries.push({ capture });
    } else if (fact.kind === 'released') {
      const entry = this.#entries.shift();
      if (!entry) throw new Error('Recording entry was released without acquisition');
      const capture = entry.capture;
      if (capture) {
        capture.entries--;
        if (capture.status === 'stopping' && capture.entries === 0) capture.status = 'stopped';
      }
    }
    return undefined;
  }
}

/** One retained analysis result; it owns no business execution or content. */
class Capture {
  readonly recorder = new Recorder(new RecordBook());
  readonly installation = bindRecording(this.recorder, {
    invalidate: () => {
      this.integrity = 'incomplete';
    },
  });
  status: 'recording' | 'stopping' | 'stopped' = 'recording';
  integrity: 'intact' | 'incomplete' = 'intact';
  entries = 0;
}

/** A child inherits its parent's exact destination even after capture is stopped. */
class CapturedInvocation implements InvocationObserver {
  constructor(
    readonly owner: ConversationRecording,
    readonly capture: Capture,
    readonly recording: InvocationRecording,
  ) {}
  get resources() {
    return this.recording.resources;
  }
  available(): boolean {
    return this.recording.available();
  }
  observe(fact: InvocationFact): void {
    this.recording.observe(fact);
  }
  resource(fact: ResourceObservation): void {
    this.recording.resource(fact);
  }
  transcript(event: TranscriptEvent): void {
    this.recording.transcript(event);
  }
  memory(event: MemoryEvent): void {
    this.recording.memory(event);
  }
}
