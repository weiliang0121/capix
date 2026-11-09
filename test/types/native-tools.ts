import { z } from 'zod';
import { Node } from '@weiliang0121/capix-structure';
import { tool } from '../../examples/native-tools/catalog.mjs';
import { acceptReply, acceptFeedback, type ToolResult } from '../../examples/native-tools/protocol.mjs';

const read = new Node<{ path: string }, { text: string }>({ run: (work) => ({ text: work.input.path }) });
const registered = tool(read, {
  description: 'Read one text document.',
  input: z.strictObject({ path: z.string() }),
  result: { succeeded: (document) => ({ status: 'ok', content: [{ kind: 'text', text: document.text }] }) },
});
const exact: typeof read = registered.node;
void exact;

tool(read, {
  description: 'Wrong input',
  // @ts-expect-error Schema output must match the actual member input.
  input: z.strictObject({ path: z.number() }),
  result: { succeeded: (document) => ({ status: 'ok', content: [{ kind: 'text', text: document.text }] }) },
});
tool(read, {
  description: 'Wrong receiver',
  input: z.strictObject({ path: z.string() }),
  result: {
    // @ts-expect-error The registered member returns a document, not a number.
    succeeded: (number: number) => ({ status: 'ok', content: [{ kind: 'text', text: String(number) }] }),
  },
});
tool(read, {
  description: 'Wrong feedback',
  input: z.strictObject({ path: z.string() }),
  // @ts-expect-error Feedback disposition is a closed explicit vocabulary.
  result: { succeeded: () => ({ status: 'handled', content: [{ kind: 'text', text: 'x' }] }) },
});

const feedback: ToolResult = { status: 'error', content: [{ kind: 'text', text: 'Not found' }] };
acceptFeedback('call', feedback);
// @ts-expect-error The loop supplies identity; authors cannot assign another call slot.
acceptFeedback('call', { ...feedback, toolCallId: 'other' });
const reply = acceptReply({});
const tokens: number | undefined = reply.usage?.totalTokens;
void tokens;
// @ts-expect-error Accepted shared reply facts are readonly.
reply.output.push({ kind: 'text', text: 'changed' });
for (const item of reply.output) {
  if (item.kind === 'tool-call') {
    const argumentText: string = item.arguments.text;
    void argumentText;
    // @ts-expect-error Raw JSON text has not been parsed or business-validated.
    const path: string = item.arguments.path;
    void path;
  }
}
