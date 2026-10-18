import type { CheckpointCodec, ResourceRequest } from '@capix/server-runtime';
import { checkpointPoint, childReference, childReferences, defineAttempt, defineChildEntry, defineExecution, defineOperation, defineRuntime } from '@capix/server-runtime';
import type { ChildReference, ChildEntryFacts as EntryFacts, OperationWork, ResourcesOf } from '@capix/server-runtime';

const metadata = { label: 'test', source: 'test', callee: 'test' };

declare function expectType<T>(value: T): void;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

interface ReadInput {
  readonly path: string;
}
interface Document {
  readonly text: string;
}
interface Reader {
  read(path: string): Document;
}
interface Logger {
  report(message: string): void;
}
interface RestoreReader {
  recover(path: string): Document;
}
declare const reader: ResourceRequest<Reader>;
declare const logger: ResourceRequest<Logger>;
declare const restoreReader: ResourceRequest<RestoreReader>;
declare const inputCodec: CheckpointCodec<ReadInput>;
declare const stringCodec: CheckpointCodec<string>;
declare const numberCodec: CheckpointCodec<number>;
declare const stateCodec: CheckpointCodec<{ readonly offset: number }>;

export const readText = defineAttempt<ReadInput, Document>()({
  ...metadata,
  name: 'readText',
  run: {
    requires: { reader },
    execute(work) {
      type Inferred = Expect<Equal<typeof work.resources.reader, Reader>>;
      expectType<Inferred>(true);
      expectType<ReadInput>(work.input);
      expectType<ReadInput>(work.initialInput);
      // @ts-expect-error A has no child access, regardless of phase.
      work.children;
      // @ts-expect-error No declared Delta produces no output writer.
      work.output;
      // @ts-expect-error Resources are precisely inferred, not an unknown index signature.
      work.resources.logger;
      // @ts-expect-error Input is not inferred to any.
      work.input.missing;
      return work.resources.reader.read(work.input.path);
    },
    accept(work) {
      expectType<Document>(work.delivered);
      expectType<Reader>(work.resources.reader);
      // @ts-expect-error accept does not own an output segment.
      work.output;
      // @ts-expect-error A accept still has no children.
      work.children;
      return work.delivered;
    },
  },
  exceptions: {
    accepts: [],
    requires: { logger },
    handle(work) {
      work.resources.logger.report('read failed');
      // @ts-expect-error Exception resources are not unioned with run resources.
      work.resources.reader;
      // @ts-expect-error A handling still has no children.
      work.children;
      return work.unhandled;
    },
  },
});

export const count = defineAttempt<number, number>()({ ...metadata, name: 'count', run: { execute: (work) => work.input + 1 } });

export const waitingPoint = checkpointPoint<'operation', ReadInput, string>()({
  name: 'waiting',
  state: stateCodec,
  references: { source: childReference(readText), copies: childReferences(readText) },
  check(state, facts) {
    expectType<number>(state.offset);
    expectType<ReadInput>(facts.input);
    expectType<ChildReference<typeof readText>>(facts.references.source.ref);
    expectType<readonly ChildReference<typeof readText>[]>(facts.references.copies.map((fact) => fact.ref));
    // @ts-expect-error A point check reads saved facts, not live resources.
    facts.resources;
    // @ts-expect-error A point check has no child action endpoints.
    facts.children.create(readText, { path: 'x' });
  },
  resume: {
    requires: { restoreReader },
    uses: [readText],
    async execute(work, state, saved) {
      type Inferred = Expect<Equal<typeof work.resources.restoreReader, RestoreReader>>;
      expectType<Inferred>(true);
      expectType<number>(state.offset);
      expectType<ChildReference<typeof readText>>(saved.source);
      expectType<readonly ChildReference<typeof readText>[]>(saved.copies);
      // @ts-expect-error Point resources are not borrowed from run or exceptions.
      work.resources.reader;
      // @ts-expect-error Point uses allows readText, not count.
      work.children.create(count, 1);
      const restored = work.children.resume(saved.source);
      const output = await restored.run();
      expectType<Document>(output);
      const accepted = await restored.accept();
      return accepted.text;
    },
  },
});

const requires = { reader };

// The extracted helper needs only a public work type and the actual requires/child declarations.
async function readAndAccept(work: OperationWork<ReadInput, string, ResourcesOf<typeof requires>, typeof readText>): Promise<string> {
  const child = work.children.create(readText, work.input);
  await child.run();
  return child.accept((document) => document.text);
}

export const operation = defineOperation<ReadInput, string>()({
  ...metadata,
  name: 'operation',
  children: [readText, count],
  run: {
    requires,
    uses: [readText],
    async execute(work) {
      const child = work.children.create(readText, work.input);
      expectType<Promise<Document>>(child.run());
      expectType<Promise<Document>>(child.accept());
      expectType<Promise<number>>(child.accept((document) => document.text.length));
      expectType<Promise<number>>(child.accept(async (document) => document.text.length));
      // @ts-expect-error Empty accept cannot invent a converted result type.
      child.accept<number>();
      // @ts-expect-error Child input is fixed by the supplied declaration.
      work.children.create(readText, 3);
      // @ts-expect-error Explicit run uses is narrower than registered children.
      work.children.create(count, 3);
      // @ts-expect-error Normal execute does not have a restore endpoint.
      work.children.resume(child.ref);
      // @ts-expect-error No Delta was declared.
      work.output;
      work.checkpoint?.save(waitingPoint, { offset: 1 }, { source: child.ref, copies: [child.ref] });
      // @ts-expect-error State shape is associated with this exact point type.
      work.checkpoint?.save(waitingPoint, { offset: 'one' }, { source: child.ref, copies: [child.ref] });
      // @ts-expect-error Single references do not accept arrays.
      work.checkpoint?.save(waitingPoint, { offset: 1 }, { source: [child.ref], copies: [child.ref] });
      // @ts-expect-error Array references do not accept one reference.
      work.checkpoint?.save(waitingPoint, { offset: 1 }, { source: child.ref, copies: child.ref });
      // @ts-expect-error Required reference roles cannot be omitted.
      work.checkpoint?.save(waitingPoint, { offset: 1 }, { source: child.ref });
      return readAndAccept(work);
    },
    accept(work) {
      expectType<string>(work.delivered);
      expectType<Reader>(work.resources.reader);
      work.children.create(readText, work.input);
      // @ts-expect-error accept retains run's explicit uses restriction.
      work.children.create(count, 1);
      // @ts-expect-error No recovery endpoint in normal accept.
      work.children.resume;
      // @ts-expect-error Checkpoint save belongs to execute.
      work.checkpoint;
      return work.round === 1 ? work.continue(work.input, 'again') : work.delivered;
    },
  },
  exceptions: {
    accepts: [],
    requires: { logger },
    uses: [count],
    handle(work) {
      expectType<Logger>(work.resources.logger);
      // @ts-expect-error Separate exception requirements do not expose run resources.
      work.resources.reader;
      work.children.create(count, 1);
      // @ts-expect-error Exception uses do not borrow run uses.
      work.children.create(readText, work.input);
      // Read-only facts cover all direct children irrespective of uses.
      const fact = work.children.facts.requireUnique(readText, { parentRound: 1 });
      work.children.open(fact.ref).accept();
      // @ts-expect-error No recovery endpoint in handling.
      work.children.resume(fact.ref);
      // @ts-expect-error Return has the declared parent output type.
      work.return(2);
      return work.return('recovered');
    },
  },
  checkpoint: { key: 'operation', version: 1, input: inputCodec, output: stringCodec, points: [waitingPoint] },
});

defineOperation<ReadInput, number>()({
  ...metadata,
  name: 'defaults',
  children: [readText, count],
  run: {
    execute(work) {
      // Omitted run uses means all declared children.
      work.children.create(readText, work.input);
      work.children.create(count, 1);
      return 1;
    },
  },
  exceptions: {
    accepts: [],
    handle(work) {
      // Omitted exception uses means none, but historical facts remain available.
      // @ts-expect-error Default exception uses does not allow new calls.
      work.children.create(count, 1);
      work.children.facts.list(readText);
      return work.unhandled;
    },
  },
});

defineOperation<ReadInput, string>()({
  ...metadata,
  name: 'uses-must-be-registered',
  children: [readText],
  run: {
    // @ts-expect-error A non-child cannot become callable merely by adding it to uses.
    uses: [count],
    execute: () => '',
  },
});

defineOperation<ReadInput, string>()({
  ...metadata,
  name: 'exception-uses-must-be-registered',
  children: [readText],
  run: { execute: () => '' },
  exceptions: {
    accepts: [],
    // @ts-expect-error Exception uses must also be part of the parent's registered children.
    uses: [count],
    handle: (work) => work.unhandled,
  },
});

checkpointPoint<'operation', ReadInput, string>()({
  name: 'default-resume-uses',
  state: stateCodec,
  references: { source: childReference(readText) },
  resume: {
    execute(work, state, saved) {
      expectType<number>(state.offset);
      // @ts-expect-error Omitted resume uses does not grant calls from the references declaration.
      work.children.create(readText, work.input);
      // @ts-expect-error Saved identity does not grant permission to resume its execution.
      work.children.resume(saved.source);
      work.children.facts.get(saved.source);
      return '';
    },
  },
});

checkpointPoint<'attempt', ReadInput, string>()({
  name: 'leaf-point-with-illegal-child',
  state: stateCodec,
  // @ts-expect-error An A point cannot declare direct-child reference roles.
  references: { source: childReference(readText) },
  resume: {
    execute(work) {
      // @ts-expect-error Restoring does not give A a child collection.
      work.children;
      return work.input.path;
    },
  },
});

defineOperation<ReadInput, number>()({
  ...metadata,
  name: 'empty-uses',
  children: [count],
  run: {
    uses: [],
    execute(work) {
      // @ts-expect-error Explicit empty uses must not fall back to all children.
      work.children.create(count, 1);
      return 1;
    },
  },
});

export const execution = defineExecution<ReadInput, string>()({
  ...metadata,
  name: 'execution',
  children: [operation],
  run: {
    execute: async (work) => {
      const child = work.children.create(operation, work.input);
      await child.run();
      return child.accept();
    },
  },
});

defineRuntime<string, string>()({
  ...metadata,
  name: 'runtime',
  children: [execution],
  run: {
    execute: async (work) => {
      const child = work.children.create(execution, { path: work.input });
      // @ts-expect-error E receives its ordinary input, with no separate entry input.
      work.children.create(execution, { request: work.input });
      expectType<ReadInput>(work.children.facts.get(child.ref).input);
      await child.run();
      return child.accept();
    },
  },
});

defineAttempt<string, string>()({
  ...metadata,
  name: 'leaf-cannot-register',
  // @ts-expect-error Attempts cannot register children.
  children: [count],
  run: { execute: (work) => work.input },
});
defineExecution<string, string>()({
  ...metadata,
  name: 'bad-E-child',
  // @ts-expect-error E allows O, not A directly.
  children: [readText],
  run: { execute: (work) => work.input },
});
defineRuntime<string, string>()({
  ...metadata,
  name: 'bad-R-child',
  // @ts-expect-error R allows E, not O directly.
  children: [operation],
  run: { execute: (work) => work.input },
});
defineOperation<string, string>()({
  ...metadata,
  name: 'bad-O-child',
  // @ts-expect-error O cannot register E.
  children: [execution],
  run: { execute: (work) => work.input },
});

defineOperation<number, number>()({
  ...metadata,
  name: 'wrong-point-owner',
  run: { execute: (work) => work.input },
  checkpoint: {
    key: 'bad',
    version: 1,
    input: numberCodec,
    output: numberCodec,
    // @ts-expect-error The independent point is tied to ReadInput/string, not number/number.
    points: [waitingPoint],
  },
});

defineAttempt<string, string>()({
  ...metadata,
  name: 'streamed',
  output: {
    result(value) {
      if (typeof value !== 'string') throw new Error('output');
      return value;
    },
    delta(value) {
      if (typeof value !== 'string') throw new Error('delta');
      return value;
    },
  },
  run: {
    execute(work) {
      work.output.emit(work.input);
      // @ts-expect-error Delta is inferred as string, not unknown or any.
      work.output.emit(1);
      return work.input;
    },
    accept(work) {
      // @ts-expect-error A declared Delta still does not grant accept a writer.
      work.output.emit('late');
      return work.delivered;
    },
  },
});

defineAttempt<string, string>()({
  ...metadata,
  name: 'result-only',
  output: {
    result(value) {
      if (typeof value !== 'string') throw new Error('output');
      return value;
    },
  },
  run: {
    execute(work) {
      // @ts-expect-error A result contract alone does not declare Delta.
      work.output.emit('not-streaming');
      return work.input;
    },
  },
});

const streamingPoint = checkpointPoint<'attempt', string, string, string>()({
  name: 'streaming-leaf',
  state: stringCodec,
  references: {},
  resume: {
    execute(work, state) {
      work.output.emit(state);
      // @ts-expect-error Resume Delta retains the declared delta type.
      work.output.emit(1);
      return work.input;
    },
  },
});
defineAttempt<string, string>()({
  ...metadata,
  name: 'streaming-point-owner',
  output: {
    result(value) {
      if (typeof value !== 'string') throw new Error('output');
      return value;
    },
    delta(value) {
      if (typeof value !== 'string') throw new Error('delta');
      return value;
    },
  },
  checkpoint: { key: 'streaming-point', version: 1, input: stringCodec, output: stringCodec, points: [streamingPoint] },
  run: { execute: (work) => work.input },
});

defineOperation<ReadInput, string>()({
  ...metadata,
  name: 'cannot-forge-control',
  run: {
    execute: () => '',
    // @ts-expect-error A plain tagged value is not a branded Continue decision.
    accept: (work) => ({ kind: 'continue', input: work.input, reason: 'not a control token' }),
  },
});

const alternate = defineChildEntry(readText, {
  accept({ input, facts }: { readonly input: { readonly filename: string }; readonly facts: EntryFacts }) {
    facts.continuation;
    // @ts-expect-error Alternate entry facts do not grant child action capability.
    facts.children.create(readText, { path: input.filename });
    return { path: input.filename };
  },
});
defineOperation<ReadInput, string>()({
  ...metadata,
  name: 'alternate-entry',
  children: [readText],
  run: {
    execute: async (work) => {
      const child = work.children.entry(alternate, { filename: work.input.path });
      // @ts-expect-error An alternate entry keeps its own input contract.
      work.children.entry(alternate, { path: work.input.path });
      await child.run();
      return child.accept((output) => output.text);
    },
  },
});

// Structurally equal definitions cannot get distinct per-object brands from TS.
// This deliberately compiles. Exact definition/ref/point identity remains a binding/runtime check.
const sameShape = defineAttempt<ReadInput, Document>()({ ...metadata, name: 'another-reader', run: { requires: { reader }, execute: () => ({ text: '' }) }, exceptions: { accepts: [], requires: { logger }, handle: (work) => work.unhandled } });
defineOperation<ReadInput, string>()({
  ...metadata,
  name: 'identity-requires-runtime-check',
  children: [readText],
  run: {
    execute(work) {
      work.children.create(sameShape, work.input);
      return '';
    },
  },
});

// A point cannot silently turn a non-streaming owner into an output producer.
// @ts-expect-error A string Delta point cannot bind to a no-Delta owner.
defineAttempt<string, string>()({ ...metadata, name: 'wrong-delta-owner', checkpoint: { key: 'wrong-delta', version: 1, input: stringCodec, output: stringCodec, points: [streamingPoint] }, run: { execute: (work) => work.input } });

defineAttempt<string, string>()({
  ...metadata,
  name: 'empty-resources',
  run: {
    execute(work) {
      // @ts-expect-error An absent resource declaration grants no arbitrary property.
      work.resources.missing;
      // @ts-expect-error No output declaration grants no writer.
      work.output;
      return work.input;
    },
  },
});

const wrongLevelPoint = checkpointPoint<'runtime', ReadInput, string>()({ name: 'wrong-level', state: stringCodec, references: {}, resume: { execute: (_work, state) => state } });
defineOperation<ReadInput, string>()({
  ...metadata,
  name: 'wrong-level-owner',
  run: { execute: () => '' },
  checkpoint: {
    key: 'wrong-level',
    version: 1,
    input: inputCodec,
    output: stringCodec,
    // @ts-expect-error Identical I/O does not make an R point an O point.
    points: [wrongLevelPoint],
  },
});

// @ts-expect-error E has no separate entry-input generic.
defineExecution<string, string, { request: string }>();
defineExecution<string, string>()({
  run: { execute: (work) => work.input },
  // @ts-expect-error Input preparation belongs to ordinary parent work, not an E entry lifecycle.
  entry: { accept: (input: string) => input },
});
