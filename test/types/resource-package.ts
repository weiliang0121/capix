import { Resource, ResourceOffer, Resources, type ResourceFailurePolicy, type ResourceOperation } from '@capix/resources';
import type { OperationResult } from '@capix/resources/operation';

declare function expectType<Value>(value: Value): void;
const origin = new Resource(new Map<string, number>());
const offer = new ResourceOffer({
  methods: {
    read(source: Map<string, number>, key: string, operation: ResourceOperation<string>) {
      operation.emit(key);
      return source.get(key) ?? 0;
    },
  },
});
const binding = new Resources().register(origin, offer).bind({ numbers: offer.request() });
const policy: ResourceFailurePolicy = { isProtected: () => false, isCancellation: () => false, describe: () => null };
const access = binding.open({ contextId: 'host', failures: policy, validate() {} });
// @ts-expect-error a host must explicitly classify its failures
binding.open({ contextId: 'host', validate() {} });
const read = access.endpoints.numbers.read;
expectType<Promise<number>>(read('key'));
expectType<Promise<number | string>>(read('key', { result: { failed: () => 'fallback' } }));
expectType<Promise<boolean | string>>(read('key', { result: { succeeded: (value) => value > 0, failed: () => 'fallback' } }));
read('key', { delta: (value) => expectType<string>(value) });
// @ts-expect-error resource method inputs do not widen to suit the receiver
read(1, { result: { succeeded: () => null } });
// @ts-expect-error delta type is fixed by the method
read('key', { delta: (value: number) => value });
// @ts-expect-error an offer cannot be supplied with an unrelated entity
offer.provide(() => new Set<string>());
expectType<OperationResult<number, { result: { failed: () => string } }>>(1);
