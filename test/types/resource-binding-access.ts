import { Resources, Resource, ResourceOffer, ResourceBinding, ResourceSupply, type ResourceOperation, type ResourceRequirements } from '@weiliang0121/capix-resources';

declare function expectType<Value>(value: Value): void;
const numbers = new ResourceOffer({
  methods: {
    read(source: Map<string, number>, key: string, operation: ResourceOperation<string>) {
      operation.emit(key);
      return source.get(key) ?? 0;
    },
  },
});
const resources = new Resources().register(new Resource(new Map<string, number>()), numbers);
const deps = { numbers: numbers.request() };
const binding = resources.bind(deps);
const access = binding.open();
expectType<Promise<number>>(access.endpoints.numbers.read('key'));
expectType<Promise<number | string>>(access.endpoints.numbers.read('key', { result: { failed: () => 'fallback' } }));
expectType<Promise<boolean | string>>(access.endpoints.numbers.read('key', { result: { succeeded: (value) => value > 0, failed: () => 'fallback' } }));
access.endpoints.numbers.read('key', { delta: (value) => expectType<string>(value) });
const supply = ResourceSupply.capture([numbers.provide(() => new Map<string, number>())], undefined);
expectType<Promise<number>>(ResourceBinding.fromSupply(deps, supply).open().endpoints.numbers.read('key'));

// @ts-expect-error registration preserves the source required by the offer
resources.register(new Resource(new Set<string>()), numbers);
// @ts-expect-error dependencies do not expose unrequested aliases
access.endpoints.other;
// @ts-expect-error business endpoints are readonly
access.endpoints.numbers = { read: async () => 1 };
// @ts-expect-error the request's endpoint type is retained without a read method
const invalid: ResourceRequirements<{ numbers: string }> = deps;
void invalid;
// @ts-expect-error operation input remains fixed by the method
access.endpoints.numbers.read(2);
// @ts-expect-error operation delta remains fixed by the producer
access.endpoints.numbers.read('key', { delta: (value: number) => value });
// @ts-expect-error a supplied host must provide its failure policy
binding.open({ contextId: 'host', validate() {} });
