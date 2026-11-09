import { Resources } from '@weiliang0121/capix-runtime';
import { Resource, ResourceOffer, type ResourceOperation, type ResourcesOf } from '@weiliang0121/capix-resources';
import { type OperationOptions } from '@weiliang0121/capix-resources/operation';

// @ts-expect-error resource declarations use a configuration object, not positional arguments
new ResourceOffer('legacy', (source: { text: string }) => source.text);
// @ts-expect-error a configuration must declare an endpoint
new ResourceOffer({ name: 'missing-endpoint' });

const offer = new ResourceOffer({
  methods: {
    read(source: { text: string }, input: number) {
      return { text: source.text.slice(input) };
    },
    async stream(source: { text: string }, input: number, operation: ResourceOperation<string>) {
      const signal: AbortSignal | undefined = operation.signal;
      operation.emit(source.text);
      return input;
    },
  },
  observation: {
    source: (source) => ({ length: source.text.length }),
    methods: {
      read: { input: (input) => input.toFixed(), output: (output) => output.text.length },
      stream: { output: (output) => output.toFixed() },
    },
  },
});
const resources = new Resources().register(new Resource({ text: 'value' }), offer);
// @ts-expect-error the actual origin must support the declared source
resources.register(new Resource({ count: 1 }), offer);
const deps = { files: offer.request() };
declare const endpoint: ResourcesOf<typeof deps>['files'];
const original: Promise<{ text: string }> = endpoint.read(0);
const mapped: Promise<number> = endpoint.read(0, {
  result: {
    succeeded(value) {
      return value.text.length;
    },
  },
});
const recovered: Promise<{ text: string } | boolean> = endpoint.read(0, {
  result: {
    failed(error) {
      const checked: unknown = error;
      return checked === null;
    },
  },
});
const both: Promise<string | boolean> = endpoint.read(0, { result: { succeeded: (value) => value.text, failed: () => false } });
const streamed: Promise<number> = endpoint.stream(0, {
  delta(value) {
    const checked: string = value;
  },
});
declare const optional: OperationOptions<{ text: string }, unknown, number>;
const conditional: Promise<{ text: string } | number> = endpoint.read(0, optional);
// @ts-expect-error business input is not an options bag or arbitrary string
endpoint.read('bad');
endpoint.read(0, {
  result: {
    // @ts-expect-error success callbacks receive the actual operation output
    succeeded(value: string) {
      return value;
    },
  },
});
endpoint.read(0, {
  // @ts-expect-error non-streaming methods have no delta values
  delta(value: number) {
    return value;
  },
});
endpoint.stream(0, {
  // @ts-expect-error declared deltas remain strings
  delta(value: number) {
    return value;
  },
});

// A precise endpoint keeps its actual synchronous type and infers its origin independently.
const precise = new ResourceOffer({
  expose(source: { count: number }, activity) {
    return { read: () => activity.runSync('read', {}, () => source.count) };
  },
});
resources.register(new Resource({ count: 1 }), precise);
// @ts-expect-error no capture means the source is exactly the exposure source
resources.register(new Resource({ text: 'wrong' }), precise);
declare const preciseEndpoint: ResourcesOf<{ value: ReturnType<typeof precise.request> }>['value'];
const synchronous: number = preciseEndpoint.read();

const snapshot = new ResourceOffer({
  timing: 'binding',
  capture: (source: { items: number[] }) => Object.freeze([...source.items]),
  expose: (captured: readonly number[]) => captured,
  describe: (captured) => ({ count: captured.length }),
  refine: (captured, count: number) => captured.slice(0, count),
});
resources.register(new Resource({ items: [1] }), snapshot);
snapshot.refine((input: { count: number }) => input.count);
// @ts-expect-error refinements accept the offer's declared selection type
snapshot.refine((input: string) => input);
// @ts-expect-error the registration takes the pre-capture origin
resources.register(new Resource([1]), snapshot);
declare const snapshotEndpoint: ResourcesOf<{ value: ReturnType<typeof snapshot.request> }>['value'];
const fixed: readonly number[] = snapshotEndpoint;

const capturedMethods = new ResourceOffer({
  capture: (source: { values: readonly number[] }) => ({ values: source.values, offset: 0 }),
  methods: {
    read(source: { values: readonly number[]; offset: number }, index: number) {
      return source.values[source.offset + index];
    },
  },
  refine: (captured, offset: number) => ({ ...captured, offset }),
});
resources.register(new Resource({ values: [1] }), capturedMethods);
capturedMethods.refine((input: number) => input);
// @ts-expect-error methods capture retains its actual origin type
resources.register(new Resource({ count: 1 }), capturedMethods);
// @ts-expect-error methods refinements cannot use another selection type
capturedMethods.refine((input: string) => input);
new ResourceOffer({
  // @ts-expect-error an offer cannot mix ordinary methods with a second endpoint constructor
  methods: {
    read(source: { value: number }) {
      return source.value;
    },
  },
  expose: (source: { value: number }) => source.value,
});
