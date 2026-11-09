import { Node, Scene, Sequence, Dynamic, withDependencies } from '@weiliang0121/capix-structure';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';

// A local, model-free resource. No files or external services are touched.
const texts = new ResourceOffer({
  methods: {
    read(origin, path) {
      if (!origin.has(path)) throw new Error(`Missing text: ${path}`);
      return origin.get(path);
    },
    write(origin, { path, text }) {
      origin.set(path, text);
      return { path, text };
    },
  },
});

export function createSequenceRunner(documents) {
  const read = new Node({ deps: { texts: texts.request() }, run: (work) => work.resources.texts.read(work.input) });
  const uppercase = new Node({ run: (work) => work.input.toUpperCase() });
  const save = new Node({ deps: { texts: texts.request() }, run: (work) => work.resources.texts.write(work.input) });
  const processing = new Sequence([{ node: read, input: ({ input }) => input.source }, uppercase, { node: save, input: ({ input, previous }) => ({ path: input.destination, text: previous }) }]);
  const scene = new Scene(processing);
  return new Runner(scene, new Resources().register(new Resource(documents), texts)).build();
}

// The flow resource is ordinary material, separate from invocation or CP facts.
const flow = new ResourceOffer({
  methods: {
    read(origin) {
      return origin.value;
    },
    write(origin, value) {
      origin.value = value;
    },
  },
});

export function createDynamicRunner() {
  // Common deps are known while authoring each node; this creates no supply.
  const common = withDependencies({ flow: flow.request() });
  const uppercase = common.node()({
    async run(work) {
      const value = work.input.toUpperCase();
      await work.resources.flow.write(value);
      return value;
    },
  });
  const decide = common.node()({
    async run(work) {
      const value = await work.resources.flow.read();
      return value === undefined ? { kind: 'call', option: 'uppercase', input: work.input } : { kind: 'finish', value };
    },
  });
  const processing = new Dynamic({ options: { uppercase }, decide, maxSteps: 1 });
  const scene = new Scene(processing);
  const resources = new Resources();
  // New material for each Group call; its descendants share controlled access.
  resources.capture(processing, () => ({ value: undefined })).register(flow, (state) => state);
  return new Runner(scene, resources).build();
}
