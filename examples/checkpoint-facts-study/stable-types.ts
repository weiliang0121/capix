import type { CallableContract, CallableInput, CallableOutput } from '@weiliang0121/capix-contracts';

// Compile-only candidate, not a production API or a declaration of stable.mjs.
// This projects admitted data into a readonly view; it is NOT ownership evidence.
// Runtime admission must still reject unsupported prototypes/accessors, nonfinite
// numbers, cycles, sparse arrays and over-budget values. Structural typing alone
// cannot establish those properties or prove that a value has already been fixed.
type StudyData = undefined | void | null | boolean | number | string | readonly StudyData[] | { readonly [key: string]: StudyData };
type StableView<Value> = Value extends object ? { readonly [Key in keyof Value]: StableView<Value[Key]> } : Value;

// No implementation is implied. A future boundary must validate/copy/freeze before
// returning this view and must never freeze the caller's mutable aliases in place.
declare function ownForStudy<Value>(value: Value & ([Value] extends [StudyData] ? unknown : never)): StableView<Value>;

type Request = { query: { text: string }; tags: string[]; optional?: string };
type Reply = { items: { text: string }[]; detail: { count: number } };
type Reception = { accepted: { answer: string }; sources: { id: string }[] };
type StudyWork<Input extends StudyData> = { readonly input: StableView<Input> };

const mutableInput: Request = { query: { text: 'question' }, tags: ['one'] };
const fixedInput = ownForStudy(mutableInput);
const work: StudyWork<Request> = { input: fixedInput };
mutableInput.query.text = 'producer still owns its draft';
mutableInput.tags.push('two');
const readable: string = work.input.query.text;
const readonlyTags: readonly string[] = work.input.tags;
// @ts-expect-error A Work input slot cannot be replaced.
work.input = fixedInput;
// @ts-expect-error Nested Work input fields are readonly.
work.input.query.text = 'rewrite';
// @ts-expect-error Work input arrays do not expose mutable push.
work.input.tags.push('rewrite');
// @ts-expect-error A readonly array cannot be assigned to a mutable array consumer.
const mutableTags: string[] = work.input.tags;

const rawReply: Reply = { items: [{ text: 'answer' }], detail: { count: 1 } };
const returned = ownForStudy(rawReply);
rawReply.items.push({ text: 'a later producer edit' });
// @ts-expect-error Returned nested record content is readonly.
returned.detail.count++;
// @ts-expect-error Array elements are recursively readonly.
returned.items[0]!.text = 'rewrite';
// @ts-expect-error Returned arrays cannot be sorted in place.
returned.items.sort();

// Reception may compute a NEW value from the readonly return, then fixes that
// value independently. This is a value example, not a substitute for ChildCalls.
const rawReception: Reception = { accepted: { answer: returned.items[0]!.text.toUpperCase() }, sources: [{ id: 'source' }] };
const received = ownForStudy(rawReception);
const acceptedAnswer: string = received.accepted.answer;
// @ts-expect-error Parent reception fields are readonly after admission.
received.accepted.answer = 'rewrite';
// @ts-expect-error Parent reception array elements are deeply readonly.
received.sources[0]!.id = 'rewrite';

const mutableTuple: [string, { values: number[] }] = ['pair', { values: [1] }];
const tuple = ownForStudy(mutableTuple);
const tupleShape: readonly [string, { readonly values: readonly number[] }] = tuple;
const tupleLength: 2 = tuple.length;
// @ts-expect-error Tuple positions remain readonly, without widening to an array.
tuple[0] = 'replacement';
// @ts-expect-error The nested array inside a tuple is readonly.
tuple[1].values.push(2);
// @ts-expect-error Tuple position 1 is a record, not a string.
const wrongTupleElement: string = tuple[1];

const absent: undefined = ownForStudy(undefined);
const optionalValue = ownForStudy({ present: undefined, values: [undefined, null] });
const present: undefined = optionalValue.present;
declare const noReturn: void;
const fixedNoReturn: void = ownForStudy(noReturn);
// TypeScript void means an ignored return, not proof that runtime returned
// undefined. Admission must inspect the actual value just like every other one.
// @ts-expect-error Do not silently narrow void to undefined.
const assumedUndefined: undefined = ownForStudy(noReturn);
// @ts-expect-error An optional string is not guaranteed to be present.
const assumedPresent: string = work.input.optional;

// Use the existing shared signature only to check extraction for concrete
// members. This does not recreate factory, Runner, ChildCalls or reception
// overloads, and does not prove their generic inference after a production change.
declare const lookup: CallableContract<'node', Request, Reply>;
declare const count: CallableContract<'node', { amount: number }, { total: number }>;
const suppliedLookup: CallableInput<typeof lookup> = mutableInput;
const lookupResult: StableView<CallableOutput<typeof lookup>> = returned;
const suppliedCount: CallableInput<typeof count> = { amount: 2 };
const countResult: StableView<CallableOutput<typeof count>> = ownForStudy({ total: 2 });
// @ts-expect-error Another member's input cannot replace this member's input.
const wrongInput: CallableInput<typeof lookup> = suppliedCount;
// @ts-expect-error Another member's output cannot replace this member's output.
const wrongOutput: StableView<CallableOutput<typeof lookup>> = countResult;
// @ts-expect-error Projection retains the concrete output field type.
const wrongCount: string = lookupResult.detail.count;

class Endpoint {
  read() {
    return 'live capability';
  }
}
// @ts-expect-error A method-bearing endpoint is not admitted passive data.
ownForStudy(new Endpoint());
// @ts-expect-error Nesting an endpoint must not make it admissible.
ownForStudy({ endpoint: new Endpoint() });
declare const maybeEndpoint: string | Endpoint;
// @ts-expect-error A safe union branch cannot hide a capability in another branch.
ownForStudy(maybeEndpoint);
// @ts-expect-error Error instances are not ordinary stable business input.
ownForStudy(new Error('failure'));
// @ts-expect-error A Map's readonly surface would still expose live mutation.
ownForStudy(new Map<string, number>());

// Known structural-typing limit: a data-shaped class with an index signature
// satisfies StudyData despite its unsupported prototype. A typed record can also
// hide a getter, and TypeScript permits NaN/Infinity as number. These assignments
// deliberately compile; neither they nor StableView certify runtime admission.
class DataShapedInstance {
  readonly [key: string]: number;
  constructor(readonly amount: number) {}
}
const staticallyDataShaped: StudyData = new DataShapedInstance(1);
const accessorRecord: { amount: number } = {
  get amount() {
    return 1;
  },
};
const nonfiniteNumber: StudyData = Number.NaN;

// Limit: readonly object properties are structurally assignable to mutable object
// properties in TypeScript. The direct writes above are rejected, but this alias
// escape compiles. Runtime copy/freeze remains required even with these views.
const mutableObjectAlias: { count: number } = returned.detail;

void [readable, readonlyTags, mutableTags, acceptedAnswer, tupleShape, tupleLength, wrongTupleElement, absent, present, fixedNoReturn, assumedUndefined, assumedPresent, suppliedLookup, lookupResult, suppliedCount, countResult, wrongInput, wrongOutput, wrongCount, staticallyDataShaped, accessorRecord, nonfiniteNumber, mutableObjectAlias];
