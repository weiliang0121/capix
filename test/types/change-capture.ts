import type { RuntimeChange } from '@capix-observer/protocol';
import { ChangeObserver, Transcript, createRuntime, type ChangeCapture, type TranscriptEvent } from '@capix-observer/runtime';

// A second local source demonstrates union reuse without inventing a production MemoryEvent.
type OtherEvent = Readonly<{ kind: 'other-changed'; value: number }>;
const observer = new ChangeObserver<RuntimeChange | OtherEvent>();
const transcriptCapture: ChangeCapture<TranscriptEvent> = observer;
const otherCapture: ChangeCapture<OtherEvent> = observer;

new Transcript([], { changes: transcriptCapture });
createRuntime({ changes: observer });
otherCapture.capture({ kind: 'other-changed', value: 1 });

// @ts-expect-error A transcript source cannot submit another source's event.
transcriptCapture.capture({ kind: 'other-changed', value: 1 });

const transcriptOnly = new ChangeObserver<TranscriptEvent>();
// @ts-expect-error A narrow capture cannot stand in for a wider capture.
const wider: ChangeCapture<TranscriptEvent | OtherEvent> = transcriptOnly;
void wider;
