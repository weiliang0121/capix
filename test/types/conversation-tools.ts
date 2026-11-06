import { z } from 'zod';
import { Node, Group } from '@capix/structure';
import { tool, createToolLoop, createToolAnswer, type ToolRegistrations } from '@capix/conversation-service/tools';
const read = new Node<{ path: string }, { text: string }>({ run: (work) => ({ text: work.input.path }) });
const registration = tool(read, { description: 'Read', input: z.strictObject({ path: z.string() }), result: { succeeded: (value) => ({ status: 'ok', content: [{ kind: 'text', text: value.text }] }) } });
const exact: typeof read = registration.node;
const accepted: ToolRegistrations = { read: registration };
const loop = createToolLoop({ tools: accepted, policyVersion: 'v1' });
createToolAnswer(loop);
void exact;
tool(read, {
  description: 'Wrong schema',
  // @ts-expect-error Registered input is the actual node input.
  input: z.strictObject({ path: z.number() }),
  result: { succeeded: (value) => ({ status: 'ok', content: [{ kind: 'text', text: value.text }] }) },
});
tool(read, {
  description: 'Wrong output',
  input: z.strictObject({ path: z.string() }),
  result: {
    // @ts-expect-error The actual output is a document, not a number.
    succeeded: (value: number) => ({ status: 'ok', content: [{ kind: 'text', text: String(value) }] }),
  },
});
tool(read, {
  description: 'Wrong feedback',
  input: z.strictObject({ path: z.string() }),
  // @ts-expect-error Feedback requires explicit ok/error disposition.
  result: { succeeded: () => ({ status: 'handled', content: [{ kind: 'text', text: 'x' }] }) },
});
const group = new Group<{ path: string }, number>({ run: (work) => work.input.path.length });
tool(group, { description: 'Length', input: z.strictObject({ path: z.string() }), result: { succeeded: (value) => ({ status: 'error', content: [{ kind: 'text', text: String(value) }] }), failed: () => ({ status: 'ok', content: [{ kind: 'text', text: 'replacement' }] }) } });
// @ts-expect-error A feedback policy version is an explicit compatibility condition.
createToolLoop({ tools: accepted });

createToolLoop({
  policyVersion: 'v1',
  tools: {
    // @ts-expect-error Raw structural objects cannot bypass the tool() I/O association.
    read: { node: read, description: 'unsafe', input: z.strictObject({ path: z.number() }), result: { succeeded: () => ({ status: 'ok', content: [{ kind: 'text', text: 'x' }] }) } },
  },
});
