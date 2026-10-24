import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const entry = fileURLToPath(new URL('./types/reception-contract.ts', import.meta.url));
const source = `
import {Node, Group, defineNode, defineGroup, defineScene, reception} from '@capix/server-runtime';
import type {NodeWork, CheckpointCodec, ChildCall, ChildContract, ChildFacts, ChildReference, CallableContract, CallableOutput, GroupWork, ReceptionDefinition, ReceptionValue} from '@capix/server-runtime';
import {z} from 'zod';

declare function expectType<T>(value: T): void;
type Input = { readonly path: string };
type Result = { readonly text: string };
type Receipt = { readonly location: string; readonly bytes: number };
const metadata = { name: 'child', label: 'child', source: 'test', callee: 'local' };
const child = defineNode<Input, Result>()({ ...metadata, run: work => ({ text: work.input.path }) });
const other = defineNode<number, boolean>()({ ...metadata, run: work => work.input > 0 });
const nested = defineGroup<Input, Result>()({ ...metadata, run: work => ({ text: work.input.path }) });
const task = defineGroup<Input, Result>()({ members: [nested], run: work => work.children.create(nested, work.input).run() });
declare const receiptValue: ReceptionValue<Receipt>;
declare const countValue: ReceptionValue<number>;
declare const undefinedValue: ReceptionValue<undefined>;
declare const voidValue: ReceptionValue<void>;
const saved = reception(child, receiptValue);
const counted = reception(child, countValue);
const absent = reception(child, undefinedValue);
const completed = reception(child, voidValue);
const nestedSaved = reception(nested, receiptValue);
const taskSaved = reception(task, receiptValue);
const wrongSaved = reception(other, receiptValue);
declare const receipt: Receipt;

const firstParent = defineGroup<Input, Receipt>()({ ...metadata, members: [child], receptions: [saved], async run(work) {
  const call = work.children.create(child, work.input);
  const result: Result = await call.run();
  const accepted: Receipt = await call.accept(saved, output => ({ location: output.text, bytes: output.text.length }));
  const history: Receipt = work.children.facts.accepted(call.ref, saved);
  expectType<string>(result.text);
  return history;
} });
const secondParent = defineGroup<Input, number>()({ ...metadata, members: [child], receptions: [counted], async run(work) {
  const call = work.children.create(child, work.input);
  await call.run();
  return call.accept(counted, result => result.text.length);
} });
defineGroup<Input, Receipt>()({ ...metadata, members: [child, nested], receptions: [saved, nestedSaved], run: () => receipt });
defineGroup<Input, Receipt>()({ members: [nested], receptions: [nestedSaved], run: () => receipt });
defineScene<Input, Receipt>()({ members: [task], receptions: [taskSaved], run: () => receipt });

declare const call: ChildCall<typeof child>;
expectType<Promise<Result>>(call.accept());
expectType<Promise<number>>(call.accept(result => result.text.length));
expectType<Promise<Receipt>>(call.accept(saved, async result => ({ location: result.text, bytes: result.text.length })));
expectType<Promise<undefined>>(call.accept(absent, () => undefined));
expectType<Promise<void>>(call.accept(completed, () => undefined));
// @ts-expect-error Accepted is fixed by the contract, not expanded by the callback
call.accept(saved, () => 1);
// @ts-expect-error the callback receives Result rather than Accepted
call.accept(saved, (value: Receipt) => value);
// @ts-expect-error child input/output association differs
call.accept(wrongSaved, () => receipt);
// @ts-expect-error omitted callback cannot attach a contract to an existing value
call.accept(saved);

declare const facts: ChildFacts;
declare const first: ChildReference<typeof child>;
declare const second: ChildReference<typeof child>;
declare const otherRef: ChildReference<typeof other>;
expectType<Receipt>(facts.accepted(first, saved));
expectType<Receipt>(facts.accepted(second, saved));
expectType<number>(facts.accepted(first, counted));
expectType<undefined>(facts.accepted(first, absent));
expectType<void>(facts.accepted(first, completed));
// @ts-expect-error ref fixes the child independently from the queried contract
facts.accepted(otherRef, saved);
// @ts-expect-error historical Accepted remains the contract's value
expectType<number>(facts.accepted(first, saved));
declare const noActions: GroupWork<Input, Receipt, {}, never>;
noActions.children.open(first);
expectType<Receipt>(noActions.children.facts.accepted(first, saved));
// @ts-expect-error typed history does not supply a create grant
noActions.children.create(child, { path: '' });

// The same contract works through a helper without carrying the parent's registry.
function received<Definition extends ChildContract, Value>(history: Pick<ChildFacts, 'accepted'>, ref: ChildReference<Definition>, contract: ReceptionDefinition<NoInfer<Definition>, Value>): Value {
  return history.accepted(ref, contract);
}
expectType<Receipt>(received(facts, first, saved));
// @ts-expect-error helper cannot infer a broader target to admit a wrong contract
received(facts, otherRef, saved);
function acceptReceipt<Definition extends ChildContract, Value>(handle: ChildCall<Definition>, contract: ReceptionDefinition<NoInfer<Definition>, Value>, receive: (result: CallableOutput<Definition>) => NoInfer<Value> | Promise<NoInfer<Value>>): Promise<Value> {
  return handle.accept(contract, receive);
}
expectType<Promise<Receipt>>(acceptReceipt(call, saved, result => ({ location: result.text, bytes: 1 })));
// @ts-expect-error helper callback cannot expand Value
acceptReceipt(call, saved, () => 1);

// A valid checker controls Value inference. Encoding and decoding cannot expand it.
const inferred = reception(child, { check(value: unknown): Receipt { if (value !== receipt) throw new Error('invalid'); return receipt; }, encode(value) { expectType<Receipt>(value); return value.location; }, decode() { return receipt; } });
expectType<Promise<Receipt>>(call.accept(inferred, () => receipt));
const receiptSchema = z.strictObject({ location: z.string(), bytes: z.number() });
declare function checkpointCodec<Value>(schema: z.ZodType<Value>): CheckpointCodec<Value>;
// An explicit unknown input removes the context-sensitive arrow/codec-spread inference cycle.
const spreadCodec = reception(child, { check: (value: unknown) => receiptSchema.parse(value), ...checkpointCodec(receiptSchema) });
expectType<Promise<Receipt>>(call.accept(spreadCodec, () => receipt));
function receiptContract<Definition extends ChildContract>(definition: Definition, value: ReceptionValue<Receipt>) {
  return reception(definition, value);
}
expectType<Promise<Receipt>>(call.accept(receiptContract(child, receiptValue), () => receipt));
declare const dateValue: ReceptionValue<Date>;
const dated = reception(child, dateValue);
expectType<Promise<Date>>(call.accept(dated, () => new Date()));
declare const asyncValue: ReceptionValue<Promise<number>>;
// @ts-expect-error a named value contract cannot make acceptance values into promises
reception(child, asyncValue);
// @ts-expect-error validators must complete synchronously
reception(child, { check: async () => 1, encode: (_value: Promise<number>) => 1, decode: () => Promise.resolve(1) });
declare const sometimesAsync: number | Promise<number>;
// @ts-expect-error promise unions cannot infer Value back to unknown
reception(child, { check: () => sometimesAsync, encode: (_value: number | Promise<number>) => 1, decode: () => sometimesAsync });
declare const thenableValue: PromiseLike<number>;
// @ts-expect-error thenable validators have the same asynchronous boundary
reception(child, { check: () => thenableValue, encode: (_value: PromiseLike<number>) => 1, decode: () => thenableValue });
// @ts-expect-error incompatible encoder input does not widen the checker's result
reception(child, { check: (_value: unknown): Receipt => receipt, encode: (value: number) => value, decode: () => receipt });
// @ts-expect-error decoder result must satisfy the checker's value contract
reception(child, { check: (_value: unknown): Receipt => receipt, encode: value => value.location, decode: () => 1 });
// @ts-expect-error Value is invariant, including adding undefined
const widenedValue: ReceptionDefinition<typeof child, Receipt | undefined> = saved;
// @ts-expect-error a narrower accepted shape is not the same contract
const narrowedValue: ReceptionDefinition<typeof child, Receipt & { id: string }> = saved;
// @ts-expect-error target signature is invariant, even when only output is erased
const widenedChild: ReceptionDefinition<CallableContract<'node', Input, unknown>, Receipt> = saved;
// @ts-expect-error a naked object cannot manufacture the type-only contract witness
const forged: ReceptionDefinition<typeof child, Receipt> = { child, value: receiptValue };

// Parent registration is constrained by children; reception cannot infer extra children.
// @ts-expect-error unknown child's reception cannot expand registration
defineGroup<Input, Receipt>()({ ...metadata, members: [child], receptions: [wrongSaved], run: () => receipt });
// @ts-expect-error no children were registered
defineGroup<Input, Receipt>()({ ...metadata, receptions: [saved], run: () => receipt });
// @ts-expect-error E cannot register an A reception
defineGroup<Input, Receipt>()({ members: [nested], receptions: [saved], run: () => receipt });
// @ts-expect-error parent registration cannot widen the registered member signature
defineScene<Input, Receipt>()({ members: [other], receptions: [nestedSaved], run: () => receipt });
// @ts-expect-error A cannot declare receptions
defineNode<Input, Receipt>()({ ...metadata, receptions: [saved], run: () => receipt });
// @ts-expect-error even an empty A reception registry is forbidden
defineNode<Input, Receipt>()({ ...metadata, receptions: [], run: () => receipt });
class BadLeaf extends Node<Input, Result> {
  readonly name = 'leaf'; readonly label = 'leaf'; readonly source = 'test'; readonly callee = 'local';
  // @ts-expect-error named classes have the same A registration boundary
  readonly receptions = [saved];
  readonly run = { deps: {}, execute: (work: NodeWork<Input, Result>) => ({ text: work.input.path }) };
}
class NamedParent extends Group<Input, Receipt> {
  readonly name = 'parent'; readonly label = 'parent'; readonly source = 'test';
  constructor() { super(); this.add(child); }
  readonly receptions = [saved];
  readonly run = { deps: {}, execute: (_work: GroupWork<Input, Receipt>) => receipt };
}

// Identity, registration and relation status remain runtime facts, not TS brands.
const sameChildOtherContract = reception(child, receiptValue);
expectType<Promise<Receipt>>(call.accept(sameChildOtherContract, () => receipt));
expectType<Receipt>(facts.accepted(first, sameChildOtherContract));
declare const sameShapedChild: typeof child;
const sameShapeContract = reception(sameShapedChild, receiptValue);
expectType<Promise<Receipt>>(call.accept(sameShapeContract, () => receipt));
`;

function diagnosticsFor(text) {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => (name === entry ? ts.createSourceFile(name, text, languageVersion, true) : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile));
  return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
}

function format(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
}

test('parent reception contracts keep child results, accepted values and historical reads distinct', () => {
  const diagnostics = diagnosticsFor(source);
  assert.equal(diagnostics.length, 0, format(diagnostics));
});

test('reception contract negative cases reject without suppression directives', () => {
  const lines = source.split('\n');
  const expectedLines = lines.flatMap((line, index) => (line.includes('@ts-expect-error') ? [index + 1] : []));
  const diagnostics = diagnosticsFor(lines.map((line) => (line.includes('@ts-expect-error') ? '' : line)).join('\n'));
  assert.ok(
    diagnostics.every((diagnostic) => diagnostic.file?.fileName === entry),
    format(diagnostics),
  );
  const actualLines = [...new Set(diagnostics.map((diagnostic) => diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line))];
  assert.deepEqual(actualLines, expectedLines, format(diagnostics));
});
