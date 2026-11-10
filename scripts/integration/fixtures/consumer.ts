// Compile private public declarations in the same isolated install as the 17 public packages.
import { ConversationHttpTransport, HttpTransport } from '@capix/client-http';
import { TranscriptReplica, type ConversationTransport, type TranscriptTransport } from '@capix/client-runtime';
import { initialActiveView, appendActiveView, type ActiveViewState } from '@capix/observer-content';
import type { TranscriptFrame, TranscriptSnapshot } from '@weiliang0121/capix-protocol';

class JsonTransport extends HttpTransport {
  read(path: string): Promise<unknown> {
    return this.get(path);
  }
}
const http = new ConversationHttpTransport('https://offline.invalid');
const conversation: ConversationTransport = http;
const transcript: TranscriptTransport = http;
const snapshot: TranscriptSnapshot = { id: 'transcript', revision: 0, start: 0, end: 0, starts: [0], messages: [] };
const frame: TranscriptFrame = { type: 'baseline', snapshot };
const replica: TranscriptReplica = TranscriptReplica.receive(undefined, frame, snapshot.id);
const selected: ActiveViewState = appendActiveView(initialActiveView('transcript', 'memories', 0, 0, []), [0], ['memory']);
if (false) {
  // @ts-expect-error Published replica snapshots retain immutable messages.
  replica.snapshot.messages.push({ role: 'user', content: 'mutate' });
  // @ts-expect-error Membership indices retain their number contract.
  appendActiveView(selected, ['wrong'], []);
  // @ts-expect-error HTTP mechanics retain their typed path boundary.
  new JsonTransport().read(42);
}
void [conversation, transcript, selected];
