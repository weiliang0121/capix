import { z } from 'zod';
import type { Stable } from '@weiliang0121/capix-contracts';
import { Node, Scene, Runner, Resources } from '@weiliang0121/capix-runtime';
import { Tool, type ToolMember } from '@weiliang0121/capix-tool';
import type { ToolResult } from '@weiliang0121/capix-model-provider';

const lookup = new Node<{ key: string }, { rows: { text: string }[] }>({ run: (work) => ({ rows: [{ text: work.input.key }] }) });
const inline = new Tool({
  policyVersion: 'v1',
  tools: {
    lookup: {
      node: lookup,
      description: 'Look up a key',
      input: z.strictObject({ key: z.string() }),
      result: {
        succeeded: (output) => {
          const text: string = output.rows[0]!.text;
          const stable: Stable<{ rows: { text: string }[] }> = output;
          // @ts-expect-error Stable rows cannot be modified by result mapping.
          output.rows.push({ text: 'mutated' });
          // @ts-expect-error Nested stable output is also readonly.
          output.rows[0]!.text = 'mutated';
          // @ts-expect-error Inference preserves each member's own output shape.
          const wrong: number = output.rows[0]!.text;
          void stable;
          void wrong;
          return { status: 'ok', content: [{ kind: 'text', text }] };
        },
      },
    },
  },
});
const explicit = {
  node: lookup,
  description: 'Lookup',
  input: z.strictObject({ key: z.string() }),
  result: { succeeded: (output) => ({ status: 'ok', content: [{ kind: 'text', text: output.rows[0]!.text }] }) },
} satisfies ToolMember<typeof lookup>;
const asyncMember = { ...explicit, result: { succeeded: async (output: Stable<{ rows: { text: string }[] }>): Promise<ToolResult> => ({ status: 'ok', content: [{ kind: 'text', text: output.rows[0]!.text }] }) } } satisfies ToolMember<typeof lookup>;
const scene = new Scene<{ request: { messages: { role: 'user'; content: string }[] } }, string>().add({ inline });
scene.run = (work) => work.children.inline.invoke(work.input);
const run = new Runner(scene, new Resources()).build();
const answer: Promise<string> = run.run({ request: { messages: [{ role: 'user', content: 'hello' }] } });
// @ts-expect-error Tool is not a Scene entry for Runner.
new Runner(inline, new Resources());
// @ts-expect-error Request wrapper is required.
run.run({ messages: [{ role: 'user', content: 'hello' }] });
// @ts-expect-error Schema must describe the member input.
new Tool({ policyVersion: 'v1', tools: { lookup: { ...explicit, input: z.number() } } });
// @ts-expect-error Mapping input cannot misstate the member output.
new Tool({ policyVersion: 'v1', tools: { lookup: { ...explicit, result: { succeeded: (output: number) => ({ status: 'ok', content: [{ kind: 'text', text: String(output) }] }) } } } });
// @ts-expect-error Mapping must return valid native ToolResult.
new Tool({ policyVersion: 'v1', tools: { lookup: { ...explicit, result: { succeeded: () => 'raw text' } } } });
// @ts-expect-error Tool requires explicit policy version.
new Tool({ tools: { lookup: explicit } });
void answer;
void asyncMember;
