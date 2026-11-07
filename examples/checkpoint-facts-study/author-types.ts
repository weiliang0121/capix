// Compile-only author-contract candidate. These declarations are NOT production
// APIs or typings for the JavaScript model. No runtime identity/admission proof
// follows from a phantom brand; real slots and refs still require authentication.
export {};

declare const childBrand: unique symbol;
declare const referenceBrand: unique symbol;
declare const slotBrand: unique symbol;
declare const occurrenceBrand: unique symbol;
declare const receptionBrand: unique symbol;
declare const materialBrand: unique symbol;

type Stable<Value> = Value extends object ? { readonly [Key in keyof Value]: Stable<Value[Key]> } : Value;
type Invariant<Value> = (value: Value) => Value;
type Child<Input, Output, Member> = { readonly [childBrand]: Invariant<{ input: Input; output: Output; member: Member }> };
type ChildRef<Input, Output, Member> = { readonly [referenceBrand]: Child<Input, Output, Member> };
type Slot<Kind extends 'one' | 'many', Scope, Input, Output, Member> = { readonly kind: Kind; readonly [slotBrand]: { readonly scope: Invariant<Scope>; readonly child: Child<Input, Output, Member> } };
type Occurrence<Scope> = { readonly [occurrenceBrand]: Invariant<Scope> };
type Reception<Input, Output, Member, Value> = { readonly [receptionBrand]: { readonly child: Child<Input, Output, Member>; readonly value: Invariant<Value> } };
type MaterialRef<Value> = { readonly [materialBrand]: Invariant<Value> };
type Receipt<Value> = { readonly status: 'accepted' | 'handled'; readonly value: Stable<Value> };
type Outcome<Output> = { readonly status: 'succeeded'; readonly value: Stable<Output> } | { readonly status: 'failed'; readonly diagnostic: { readonly code: string } };
type Fact<Input, Output> = { readonly input: Stable<Input>; readonly returned?: Outcome<Output>; readonly phase: 'waiting' | 'returned' | 'receiving' | 'accepted' | 'handled' };

declare function create<Input, Output, Member>(child: Child<Input, Output, Member>, input: NoInfer<Input>): ChildRef<Input, Output, Member>;
declare function single<Scope extends symbol, Input, Output, Member>(scope: Scope, child: Child<Input, Output, Member>): Slot<'one', Scope, Input, Output, Member>;
declare function many<Scope extends symbol, Input, Output, Member>(scope: Scope, child: Child<Input, Output, Member>): Slot<'many', Scope, Input, Output, Member>;
declare function selectReference<Scope, Input, Output, Member>(slot: Slot<'one', Scope, Input, Output, Member>, ref: NoInfer<ChildRef<Input, Output, Member>>): void;
declare function addReference<Scope, Input, Output, Member>(slot: Slot<'many', Scope, Input, Output, Member>, ref: NoInfer<ChildRef<Input, Output, Member>>, options?: { readonly before?: Occurrence<NoInfer<Scope>> }): Occurrence<Scope>;
declare function removeReference<Scope, Input, Output, Member>(slot: Slot<'many', Scope, Input, Output, Member>, occurrence: Occurrence<NoInfer<Scope>>): void;

declare const facts: {
  relation<Input, Output, Member>(ref: ChildRef<Input, Output, Member>): Fact<Input, Output>;
  reception<Input, Output, Member, Value>(ref: ChildRef<Input, Output, Member>, contract: Reception<NoInfer<Input>, NoInfer<Output>, NoInfer<Member>, Value>): Receipt<Value>;
};
declare function captureMaterial<Value>(value: Value): MaterialRef<Value>;
declare function readMaterial<Value>(ref: MaterialRef<Value>): Stable<Value>;

declare const translateId: unique symbol;
declare const alternateId: unique symbol;
declare const countId: unique symbol;
declare const activeScope: unique symbol;
declare const historyScope: unique symbol;
declare const otherScope: unique symbol;
type Input = { text: string };
type Output = { translation: string; sources: string[] };
declare const translate: Child<Input, Output, typeof translateId>;
declare const alternate: Child<Input, Output, typeof alternateId>;
declare const count: Child<{ count: number }, { total: number }, typeof countId>;
declare const acceptedTranslation: Reception<Input, Output, typeof translateId, { answer: string }>;
declare const alternateReception: Reception<Input, Output, typeof alternateId, { answer: string }>;

const first = create(translate, { text: 'first' });
const second = create(translate, { text: 'second' });
const other = create(alternate, { text: 'same shape, different declaration' });
const counter = create(count, { count: 1 });
const active = single(activeScope, translate);
const history = many(historyScope, translate);
const anotherHistory = many(otherScope, translate);
selectReference(active, first);
selectReference(active, second);

// Slot membership is an ordered sequence of occurrences, not a set of children.
// The same child may occur twice. Removing one occurrence does not delete either
// the other occurrence or the parent's authenticated relationship ledger.
const firstOccurrence = addReference(history, first);
const duplicateOccurrence = addReference(history, first);
const earlierOccurrence = addReference(history, second, { before: firstOccurrence });
const foreignOccurrence = addReference(anotherHistory, first);
removeReference(history, duplicateOccurrence);
const stillQueryable = facts.relation(first);
const inputText: string = stillQueryable.input.text;
if (stillQueryable.returned?.status === 'succeeded') {
  const resultText: string = stillQueryable.returned.value.translation;
  void resultText;
}
const receipt = facts.reception(first, acceptedTranslation);
const answer: string = receipt.value.answer;

// Saving a local snapshot does not declare a successful returned/accepted fact.
const material = captureMaterial({ text: 'captured version', entries: [{ key: 1 }] });
const capturedText: string = readMaterial(material).text;

// @ts-expect-error The member's input remains exact.
create(translate, { count: 1 });
// @ts-expect-error Same I/O does not make another member this declaration.
selectReference(active, other);
// @ts-expect-error Different I/O cannot be widened into the slot's child.
addReference(history, counter);
// @ts-expect-error A single slot does not have sequence occurrences.
addReference(active, first);
// @ts-expect-error A many slot cannot be assigned like a single role.
selectReference(history, first);
// @ts-expect-error Removal addresses one membership occurrence, not the child.
removeReference(history, first);
// @ts-expect-error Occurrences belong to the slot that issued them.
removeReference(history, foreignOccurrence);
// @ts-expect-error Insertion anchors belong to this sequence.
addReference(history, second, { before: foreignOccurrence });
// @ts-expect-error Raw strings do not grant membership authority.
removeReference(history, 'entry-id');
// @ts-expect-error Facts require a child reference, not its declaration.
facts.relation(translate);
// @ts-expect-error Receipt contract belongs to a different declaration.
facts.reception(first, alternateReception);
// @ts-expect-error Receipt data retains its declared type.
const wrongAnswer: number = receipt.value.answer;
// @ts-expect-error Receipt content is readonly.
receipt.value.answer = 'changed';
// @ts-expect-error A pending child need not have returned at all.
const unconditionallyReturned: Outcome<Output> = stillQueryable.returned;
// @ts-expect-error A local material reference is not a child reference.
facts.relation(material);
// @ts-expect-error A child reference is not a saved local material reference.
readMaterial(first);
// @ts-expect-error Material existence cannot prove successful delivery.
const forgedDelivery: Receipt<{ text: string }> = material;
// @ts-expect-error Captured material is deeply readonly.
readMaterial(material).entries.push({ key: 2 });
// @ts-expect-error Preserving exact I/O also forbids an unknown-valued widening.
const widenedChild: Child<Input, unknown, typeof translateId> = translate;

// Static limits: refs to different invocations of one declaration intentionally
// have the same type. Runtime checks must reject a foreign parent, stale slot,
// wrong occurrence, forged wire identity and terminal/phase-invalid reception.
// These explicit symbols are a fixture, not proof of factory inference or of
// automatic nominal identity for arbitrary user-created nodes.
void [firstOccurrence, earlierOccurrence, inputText, answer, capturedText, wrongAnswer, unconditionallyReturned, forgedDelivery, widenedChild];
