import type { CheckpointCodec } from '@weiliang0121/capix-runtime';
import type { ResourceRequest } from '@weiliang0121/capix-resources';
import { checkpointPoint, childReference, childReferences, defineNode, defineGroup, defineScene } from '@weiliang0121/capix-runtime';
import type { ChildReference, GroupWork } from '@weiliang0121/capix-runtime';
import type { ResourcesOf } from '@weiliang0121/capix-resources';

const metadata = { label: 'test', source: 'test' };

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

export const readText = defineNode<ReadInput, Document>()({
  ...metadata,
  name: 'readText',
  deps: { reader },
  run(work) {
    type Inferred = Expect<Equal<typeof work.resources.reader, Reader>>;
    expectType<Inferred>(true);
    expectType<ReadInput>(work.input);
    // @ts-expect-error normal processing has one input
    work.initialInput;
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
});

export const count = defineNode<number, number>()({ ...metadata, name: 'count', run: (work) => work.input + 1 });

export const waitingPoint = checkpointPoint<'group', ReadInput, string>()({
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
    deps: { restoreReader },
    uses: [readText],
    async run(work, state, saved) {
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

const deps = { reader };

// The extracted helper needs only a public work type and the actual deps/child declarations.
async function readAndAccept(work: GroupWork<ReadInput, string, ResourcesOf<typeof deps>, typeof readText>): Promise<string> {
  const child = work.children.create(readText, work.input);
  await child.run();
  return child.accept((document) => document.text);
}

export const operation = defineGroup<ReadInput, string>()({
  ...metadata,
  name: 'operation',
  members: [readText, count],
  deps,
  async run(work) {
    const child = work.children.create(readText, work.input);
    expectType<Promise<Document>>(child.run());
    expectType<Promise<Document>>(child.accept());
    expectType<Promise<number>>(child.accept((document) => document.text.length));
    expectType<Promise<number>>(child.accept(async (document) => document.text.length));
    // @ts-expect-error Empty accept cannot invent a converted result type.
    child.accept<number>();
    // @ts-expect-error Child input is fixed by the supplied declaration.
    work.children.create(readText, 3);
    work.children.create(count, 3);
    // @ts-expect-error Normal execute does not have a restore endpoint.
    work.children.resume(child.ref);
    // @ts-expect-error No Delta was declared.
    work.output;
    work.checkpoint?.({ point: waitingPoint, state: { offset: 1 }, refs: { source: child.ref, copies: [child.ref] } });
    // @ts-expect-error State shape is associated with this exact point type.
    work.checkpoint?.({ point: waitingPoint, state: { offset: 'one' }, refs: { source: child.ref, copies: [child.ref] } });
    // @ts-expect-error Single references do not accept arrays.
    work.checkpoint?.({ point: waitingPoint, state: { offset: 1 }, refs: { source: [child.ref], copies: [child.ref] } });
    // @ts-expect-error Array references do not accept one reference.
    work.checkpoint?.({ point: waitingPoint, state: { offset: 1 }, refs: { source: child.ref, copies: child.ref } });
    // @ts-expect-error Required reference roles cannot be omitted.
    work.checkpoint?.({ point: waitingPoint, state: { offset: 1 }, refs: { source: child.ref } });
    return readAndAccept(work);
  },
  checkpoint: { key: 'operation', version: 1, input: inputCodec, output: stringCodec, points: [waitingPoint] },
});

defineGroup<ReadInput, number>()({
  ...metadata,
  name: 'defaults',
  members: [readText, count],
  run(work) {
    // Omitted run uses means all declared children.
    work.children.create(readText, work.input);
    work.children.create(count, 1);
    return 1;
  },
});

checkpointPoint<'group', ReadInput, string>()({
  name: 'default-resume-uses',
  state: stateCodec,
  references: { source: childReference(readText) },
  resume: {
    run(work, state, saved) {
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

checkpointPoint<'node', ReadInput, string>()({
  name: 'leaf-point-with-illegal-child',
  state: stateCodec,
  // @ts-expect-error An A point cannot declare direct-child reference roles.
  references: { source: childReference(readText) },
  resume: {
    run(work) {
      // @ts-expect-error Restoring does not give A a child collection.
      work.children;
      return work.input.path;
    },
  },
});

export const execution = defineGroup<ReadInput, string>()({
  ...metadata,
  name: 'execution',
  members: [operation],
  run: async (work) => {
    const child = work.children.create(operation, work.input);
    await child.run();
    return child.accept();
  },
});

defineScene<string, string>()({
  ...metadata,
  name: 'runtime',
  members: [execution],
  run: async (work) => {
    const child = work.children.create(execution, { path: work.input });
    // @ts-expect-error E receives its ordinary input, with no separate entry input.
    work.children.create(execution, { request: work.input });
    expectType<ReadInput>(work.children.facts.get(child.ref).input);
    await child.run();
    return child.accept();
  },
});

defineNode<string, string>()({
  ...metadata,
  name: 'leaf-cannot-register',
  // @ts-expect-error Attempts cannot register children.
  members: [count],
  run: (work) => work.input,
});
defineGroup<string, string>()({
  ...metadata,
  name: 'bad-E-child',
  // Composite membership accepts this direct relationship.
  members: [readText],
  run: (work) => work.input,
});
defineScene<string, string>()({
  ...metadata,
  name: 'bad-R-child',
  // Composite membership accepts this direct relationship.
  members: [operation],
  run: (work) => work.input,
});
defineGroup<string, string>()({
  ...metadata,
  name: 'bad-O-child',
  // Composite membership accepts this direct relationship.
  members: [execution],
  run: (work) => work.input,
});

defineGroup<number, number>()({
  ...metadata,
  name: 'wrong-point-owner',
  run: (work) => work.input,
  checkpoint: {
    key: 'bad',
    version: 1,
    input: numberCodec,
    output: numberCodec,
    // @ts-expect-error The independent point is tied to ReadInput/string, not number/number.
    points: [waitingPoint],
  },
});

defineNode<string, string>()({
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
  run(work) {
    work.output.emit(work.input);
    // @ts-expect-error Delta is inferred as string, not unknown or any.
    work.output.emit(1);
    return work.input;
  },
});

defineNode<string, string>()({
  ...metadata,
  name: 'result-only',
  output: {
    result(value) {
      if (typeof value !== 'string') throw new Error('output');
      return value;
    },
  },
  run(work) {
    // @ts-expect-error A result contract alone does not declare Delta.
    work.output.emit('not-streaming');
    return work.input;
  },
});

const streamingPoint = checkpointPoint<'node', string, string, string>()({
  name: 'streaming-leaf',
  state: stringCodec,
  references: {},
  resume: {
    run(work, state) {
      work.output.emit(state);
      // @ts-expect-error Resume Delta retains the declared delta type.
      work.output.emit(1);
      return work.input;
    },
  },
});
defineNode<string, string>()({
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
  run: (work) => work.input,
});

const prepareRead = (input: { readonly filename: string }): ReadInput => ({ path: input.filename });
defineGroup<ReadInput, string>()({
  ...metadata,
  name: 'prepared-input',
  members: [readText],
  run: async (work) => {
    const child = work.children.create(readText, prepareRead({ filename: work.input.path }));
    // @ts-expect-error ordinary input preparation keeps its own argument contract
    prepareRead({ path: work.input.path });
    await child.run();
    return child.accept((output) => output.text);
  },
});

// Structurally equal definitions cannot get distinct per-object brands from TS.
// This deliberately compiles. Exact definition/ref/point identity remains a binding/runtime check.
const sameShape = defineNode<ReadInput, Document>()({ ...metadata, name: 'another-reader', deps: { reader }, run: () => ({ text: '' }) });
defineGroup<ReadInput, string>()({
  ...metadata,
  name: 'identity-deps-runtime-check',
  members: [readText],
  run(work) {
    work.children.create(sameShape, work.input);
    return '';
  },
});

// A point cannot silently turn a non-streaming owner into an output producer.
// @ts-expect-error A string Delta point cannot bind to a no-Delta owner.
defineNode<string, string>()({ ...metadata, name: 'wrong-delta-owner', checkpoint: { key: 'wrong-delta', version: 1, input: stringCodec, output: stringCodec, points: [streamingPoint] }, run: (work) => work.input });

defineNode<string, string>()({
  ...metadata,
  name: 'empty-resources',
  run(work) {
    // @ts-expect-error An absent resource declaration grants no arbitrary property.
    work.resources.missing;
    // @ts-expect-error No output declaration grants no writer.
    work.output;
    return work.input;
  },
});

const wrongLevelPoint = checkpointPoint<'scene', ReadInput, string>()({ name: 'wrong-level', state: stringCodec, references: {}, resume: { run: (_work, state) => state } });
defineGroup<ReadInput, string>()({
  ...metadata,
  name: 'wrong-level-owner',
  run: () => '',
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
defineGroup<string, string, { request: string }>();
defineGroup<string, string>()({
  run: (work) => work.input,
  // @ts-expect-error Input preparation belongs to ordinary parent work, not an E entry lifecycle.
  entry: { accept: (input: string) => input },
});
