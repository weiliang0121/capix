import { Node, Group, reception, type ChildCalls, type ChildReceptionOptions } from '@capix/server-runtime';

declare const calls: ChildCalls;
const text = new Node<number, string, {}, {}, string>({
  output: { result: (value) => String(value), delta: (value) => String(value) },
  run(work) {
    work.output.emit('preview');
    return String(work.input);
  },
});
const other = new Node<string, number>({ run: (work) => work.input.length });
const numberValue = reception(text, {
  check(value: unknown): number {
    if (typeof value !== 'number') throw Error('number');
    return value;
  },
  encode: (value) => value,
  decode(value) {
    if (typeof value !== 'number') throw Error('number');
    return value;
  },
});
const textValue = reception(text, {
  check(value: unknown): string {
    if (typeof value !== 'string') throw Error('string');
    return value;
  },
  encode: (value) => value,
  decode(value) {
    if (typeof value !== 'string') throw Error('string');
    return value;
  },
});
const noValue = reception(text, { check: () => undefined, encode: () => null, decode: () => undefined });

const succeeded: Promise<number> = calls.invoke(text, 1, { reception: numberValue, result: { succeeded: (value) => value.length } });
const handled: Promise<number> = calls.invoke(text, 1, { reception: numberValue, result: { succeeded: async (value) => value.length, failed: () => 0 } });
const untouched: Promise<string> = calls.invoke(text, 1, { reception: textValue });
const onlyFailed: Promise<string> = calls.invoke(text, 1, { reception: textValue, result: { failed: () => 'fallback' } });
const noCallbacks: Promise<string> = calls.invoke(text, 1, { reception: textValue, result: {} });
const acceptedUndefined: Promise<undefined> = calls.invoke(text, 1, { reception: noValue, result: { succeeded: () => undefined } });
const unlabelledFailure: Promise<string | number> = calls.invoke(text, 1, { result: { failed: () => 0 } });
const typedOptions: ChildReceptionOptions<typeof text, number> = {
  reception: numberValue,
  result: { succeeded: (value) => value.length },
  delta(value) {
    const fragment: string = value;
    void fragment;
  },
};
const usingTypedOptions: Promise<number> = calls.invoke(text, 1, typedOptions);
// @ts-expect-error contract Value is fixed before success conversion
calls.invoke(text, 1, { reception: numberValue, result: { succeeded: () => 'wrong' } });
// @ts-expect-error failure conversion cannot widen the contract Value
calls.invoke(text, 1, { reception: numberValue, result: { succeeded: (value) => value.length, failed: () => 'wrong' } });
// @ts-expect-error absent success converter would accept string as number
calls.invoke(text, 1, { reception: numberValue });
// @ts-expect-error failure-only converter does not change the successful string
calls.invoke(text, 1, { reception: numberValue, result: { failed: () => 0 } });
// @ts-expect-error a reception retains its child's signature
calls.invoke(other, 'input', { reception: numberValue, result: { succeeded: (value) => value } });
// @ts-expect-error delta is the child stream contract, not accepted Value
calls.invoke(text, 1, { reception: numberValue, result: { succeeded: (value) => value.length }, delta: (value: number) => {} });
// @ts-expect-error explicitly typed options cannot bypass required success conversion
const invalidPartial: ChildReceptionOptions<typeof text, number> = { reception: numberValue, result: { failed: () => 0 } };
// @ts-expect-error Value cannot be widened from the receiver
const invalidResult: ChildReceptionOptions<typeof text, number> = { reception: numberValue, result: { succeeded: () => false } };

new Group<number, string>().add({ text }).setRun(async (work) => {
  const mapped: number = await work.children.text.invoke(1, {
    reception: numberValue,
    result: { succeeded: (value) => value.length },
    delta(value) {
      const fragment: string = value;
      void fragment;
    },
  });
  const recovered: string = await work.children.text.invoke(1, { reception: textValue, result: { failed: () => 'fallback' } });
  const empty: undefined = await work.children.text.invoke(1, { reception: noValue, result: { succeeded: () => undefined } });
  const unlabelled: string | number = await work.children.text.invoke(1, { result: { failed: () => 0 } });
  // @ts-expect-error named operations preserve success Value
  work.children.text.invoke(1, { reception: numberValue, result: { succeeded: () => 'wrong' } });
  // @ts-expect-error named operations preserve failure Value
  work.children.text.invoke(1, { reception: numberValue, result: { succeeded: (value) => value.length, failed: () => 'wrong' } });
  // @ts-expect-error named operations require a successful conversion
  work.children.text.invoke(1, { reception: numberValue, result: { failed: () => 0 } });
  // @ts-expect-error named delta remains string
  work.children.text.invoke(1, { reception: textValue, delta: (value: number) => {} });
  return recovered + mapped + empty + unlabelled;
});
void [succeeded, handled, untouched, onlyFailed, noCallbacks, acceptedUndefined, unlabelledFailure, usingTypedOptions, invalidPartial, invalidResult];
