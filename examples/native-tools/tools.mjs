import { z } from 'zod';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, checkpointPoint } from '@weiliang0121/capix-structure';
import { createCatalog, tool } from './catalog.mjs';
import { fixed } from './value.mjs';

export class ExpectedToolFailure extends Error {}
export const ToolResource = new ResourceOffer({
  name: 'example.native-tools.files',
  methods: {
    read(source, { path }) {
      source.reads++;
      if (!source.files.has(path)) throw new ExpectedToolFailure(`Missing file: ${path}`);
      return source.files.get(path);
    },
    write(source, { path, text }) {
      source.writes++;
      source.files.set(path, text);
      return `saved:${path}`;
    },
  },
});

const inputSchemas = {
  read_text: z.strictObject({ path: z.string() }),
  save_text: z.strictObject({ path: z.string(), text: z.string() }),
};
const feedback = (status, text) => ({ status, content: [{ kind: 'text', text }] });

export function createFileTools(write) {
  function file(name, method, description) {
    const input = inputSchemas[name];
    const text = { encode: (value) => z.string().parse(value), decode: (value) => z.string().parse(value) };
    const done = checkpointPoint()({ name: 'completed', state: text, references: {}, resume: { run: (_work, value) => value } });
    const node = new Node({
      name,
      deps: { files: ToolResource.request() },
      checkpoint: { key: `example.native-tools.${name}`, version: 1, input: { encode: (value) => input.parse(value), decode: (value) => input.parse(value) }, output: text, points: [done] },
      async run(work) {
        const value = await work.resources.files[method](work.input);
        write(work, { point: done, state: value, refs: {} });
        return value;
      },
    });
    return tool(node, {
      description,
      input,
      result: {
        succeeded: (value) => feedback('ok', value),
        failed(error) {
          if (!(error instanceof ExpectedToolFailure)) throw error;
          return feedback('error', error.message);
        },
      },
    });
  }
  return { read_text: file('read_text', 'read', 'Read one named file'), save_text: file('save_text', 'write', 'Write one named file') };
}

/** One ordered registration drives both actual members and model-facing catalog. */
export function toolEntries(registrations) {
  const entries = Object.entries(registrations).map(([name, registration]) => [name, tool(registration.node, { description: registration.description, input: registration.input, result: registration.result })]);
  const seen = new Set();
  for (const [name, registration] of entries) {
    if (['models', 'completion'].includes(name) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name)) throw new TypeError('Invalid or reserved tool name');
    if (seen.has(registration.node)) throw new TypeError('A tool structure cannot occupy multiple member positions');
    seen.add(registration.node);
    if (!registration.node.checkpoint) throw new TypeError('This recoverable example requires each tool to declare a checkpoint contract');
  }
  return Object.freeze(entries.map(([name, registration], index) => Object.freeze({ name, registration, position: index + 1 })));
}

export function toolCatalog(entries, policyVersion) {
  return createCatalog(
    entries.map(({ name, registration, position }) => {
      const { $schema, ...schema } = z.toJSONSchema(registration.input, { target: 'draft-7' });
      return { name, description: registration.description, schema: fixed(schema), member: { position, contract: registration.node.checkpoint.key, version: registration.node.checkpoint.version } };
    }),
    { policyVersion },
  );
}
