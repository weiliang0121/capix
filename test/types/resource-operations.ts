import { Resource, Resources, ResourceOffer, type ResourceOperation, type OperationOptions, type ResourcesOf } from '@capix/server-runtime';
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
