import { Transcript, TranscriptRangeReader, TranscriptRangeRef, TranscriptFacts, type Message, type MessageLocator, type TranscriptRangeLocator, type TranscriptSnapshot, type TranscriptEvent } from '@weiliang0121/capix-transcript';

const input: Message = { role: 'user', content: 'one' };
input.content = 'editable candidate';
const transcript = new Transcript([input]);
const message: Readonly<Message> = transcript.get(0)!;
const locator: MessageLocator = { transcriptId: transcript.id, index: 0 };
const range: TranscriptRangeLocator = new TranscriptRangeReader(new TranscriptRangeRef(transcript, 0, transcript.length)).locate();
const snapshot: TranscriptSnapshot = { id: transcript.id, revision: transcript.revision, start: 0, end: transcript.length, starts: transcript.exportState().starts, messages: transcript.snapshot() };
const event: TranscriptEvent = { type: 'transcript', transcriptId: transcript.id, revision: transcript.revision, occurredAt: 'now', origin: { contextId: 'context' }, change: { kind: 'messages-appended', start: 0, messages: [message] } };
TranscriptFacts.create(event);
// @ts-expect-error accepted messages cannot be changed
message.content = 'rewrite';
// @ts-expect-error locators are fixed positions
locator.index = 1;
// @ts-expect-error ranges are fixed boundaries
range.end = 2;
// @ts-expect-error snapshots preserve the full historical origin
const partial: TranscriptSnapshot = { ...snapshot, start: 1 };
// @ts-expect-error snapshot messages are immutable
snapshot.messages[0]!.content = 'rewrite';
// @ts-expect-error snapshot arrays cannot be extended
snapshot.messages.push(input);
if (event.change.kind === 'messages-appended') {
  // @ts-expect-error change arrays cannot be extended
  event.change.messages.push(input);
}
// @ts-expect-error only formal user and assistant messages are supported
const invalid: Message = { role: 'system', content: 'text' };
void partial;
void invalid;
