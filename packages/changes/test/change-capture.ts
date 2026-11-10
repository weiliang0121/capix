import { ChangeBuffer, type ChangeCapture } from '@weiliang0121/capix-changes';

type TranscriptEvent = Readonly<{ kind: 'transcript-changed'; revision: number }>;

// A second local source demonstrates union reuse without inventing a production MemoryEvent.
type OtherEvent = Readonly<{ kind: 'other-changed'; value: number }>;
const observer = new ChangeBuffer<TranscriptEvent | OtherEvent>();
const transcriptCapture: ChangeCapture<TranscriptEvent> = observer;
const otherCapture: ChangeCapture<OtherEvent> = observer;

otherCapture.capture({ kind: 'other-changed', value: 1 });

// @ts-expect-error A transcript source cannot submit another source's event.
transcriptCapture.capture({ kind: 'other-changed', value: 1 });

const transcriptOnly = new ChangeBuffer<TranscriptEvent>();
// @ts-expect-error A narrow capture cannot stand in for a wider capture.
const wider: ChangeCapture<TranscriptEvent | OtherEvent> = transcriptOnly;
void wider;
