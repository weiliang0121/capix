import { stableValue } from '@weiliang0121/capix-contracts';
import type { Stable } from '@weiliang0121/capix-contracts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type UnknownRemainsUnknown = Assert<Equal<Stable<unknown>, unknown>>;
// Explicit any remains an erased author type; runtime validation is unchanged.
type ExplicitAnyRemainsErased = Assert<Equal<Stable<any>, any>>;
type Tuple = Assert<Equal<Stable<[string, { count: number }]>, readonly [string, { readonly count: number }]>>;
type Union = Assert<Equal<Stable<{ kind: 'one'; value: number[] } | { kind: 'two'; value: string }>, { readonly kind: 'one'; readonly value: readonly number[] } | { readonly kind: 'two'; readonly value: string }>>;

const source = { nested: { count: 1 }, items: [{ text: 'hello' }], optional: undefined as { value: number } | undefined };
const fixed = stableValue(source);
const count: number = fixed.nested.count;
const items: readonly { readonly text: string }[] = fixed.items;
const again: Stable<typeof source> = stableValue<typeof source>(fixed);
const inferredAgain: Stable<typeof source> = stableValue(fixed);
const originalAccepted: Stable<typeof source> = stableValue<typeof source>(source);
// @ts-expect-error stable child records cannot be edited.
fixed.nested.count = 2;
// @ts-expect-error stable arrays cannot append mutable values.
fixed.items.push({ text: 'changed' });
// @ts-expect-error stable nested array values cannot be edited.
fixed.items[0]!.text = 'changed';
// @ts-expect-error stable output cannot promise a mutable array.
const mutableItems: { text: string }[] = fixed.items;
if (fixed.optional) {
  // @ts-expect-error optional branches remain deeply readonly.
  fixed.optional.value = 2;
}
const tuple = stableValue<[string, { count: number }]>(['a', { count: 1 }]);
// @ts-expect-error tuple position cannot be replaced.
tuple[0] = 'b';
// @ts-expect-error tuple nested values remain readonly.
tuple[1].count = 2;
const method = stableValue({
  run() {
    return 1;
  },
});
// @ts-expect-error unsupported function leaf cannot be consumed as a capability.
method.run();
declare const unknown: unknown;
const checked: unknown = stableValue(unknown);
// @ts-expect-error unknown data is not turned into an invented record shape.
const fabricated: { count: number } = stableValue(unknown);
