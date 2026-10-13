import { ClientSubmission, type ClientRuntime } from '@capix/client-runtime';
import type { ConversationRequest } from '@capix/protocol';

declare const runtime: ClientRuntime;
declare const request: ConversationRequest;
let notifications = 0;
void runtime.submit(request, () => {
  notifications++;
});
void new ClientSubmission('fixture-conversation', { messages: [{ role: 'user', content: 'input' }] }, () => undefined);
// @ts-expect-error Acceptance notifications are synchronous; promises cannot participate in their lifecycle.
void runtime.submit(request, async () => {});
// @ts-expect-error Accidental return values are rejected instead of ignored.
void runtime.submit(request, () => notifications++);
// @ts-expect-error The tracking object enforces the same callback contract.
void new ClientSubmission('fixture-conversation', { messages: [{ role: 'user', content: 'input' }] }, async () => {});
