import { Sequence, InvocationEntry, type OperationDefinition, type AttemptDefinition, type InvocationView, type ExecutionContextView, type OperationContextView, type ChildBindings, assembleRuntime, type ExecutionDefinition, type RuntimeDefinition, type RuntimeContextView } from '@capix/server-runtime';
import { bindChildResources, type ResourceRefinement } from '@capix/server-runtime';

const bounded = new ResourceOffer<{ readonly allowed: readonly string[] }, readonly string[], { readonly allowed: readonly string[] }, string>('bounded', (source) => source.allowed, 'access', { refine: (source, selected) => ({ allowed: source.allowed.filter((value) => value === selected) }) });
declare const fileOperation: OperationDefinition<{ readonly path: string }, string>;
bindChildResources(fileOperation, [bounded.refine<{ readonly path: string }>((input) => input.path)]);
// @ts-expect-error only a resource offer can issue the nominal refinement contract
const forgedRefinement: ResourceRefinement<{ readonly path: string }> = { offer: bounded.request().offer };
void forgedRefinement;
const issuedRefinement = bounded.refine<{ readonly path: string }>((input) => input.path);
// @ts-expect-error resource validation cannot be replaced with arbitrary capture logic
issuedRefinement.apply = () => ({ allowed: ['outside'] });
// @ts-expect-error binding input must match the selected definition's input
bindChildResources(fileOperation, [bounded.refine<number>((input) => String(input))]);
// @ts-expect-error selection must use the contract defined by the resource
bounded.refine<{ readonly path: string }>(() => 42);
declare const fileExecution: ExecutionDefinition<{ readonly path: string }, string>;
// @ts-expect-error E captures its own resources; child refinement is for O/A
bindChildResources(fileExecution, [bounded.refine<{ readonly path: string }>((input) => input.path)]);

declare const length: OperationDefinition<string, number>;
declare const format: OperationDefinition<number, string>;
declare const leaf: AttemptDefinition<string, string>;
declare const parent: InvocationView<unknown, unknown, ExecutionContextView>;
declare const operation: InvocationView<unknown, unknown, OperationContextView>;
declare const bindings: ChildBindings;

const sequence = new Sequence<string, typeof parent>().step('length', { use: length, input: ({ input }) => input }).step('format', { use: format, input: ({ outputs }) => outputs.length, accept: (_scope, value) => ({ text: value }) });
const result: Promise<Readonly<{ length: number; format: { text: string } }>> = sequence.run(parent, 'hello', bindings);
void result;
new Sequence<string, typeof parent>().step('bad', {
  use: length,
  // @ts-expect-error input must match the declared input
  input: () => 123,
});
new Sequence<string, typeof parent>().step('first', {
  use: length,
  // @ts-expect-error a later output is unavailable before its step
  input: ({ outputs }) => outputs.future,
});
// @ts-expect-error composition positions must be unique
sequence.step('length', { use: length, input: () => 'again' });
// @ts-expect-error A cannot be a direct child of E
new Sequence<string, typeof parent>().step('leaf', { use: leaf, input: ({ input }) => input });
// @ts-expect-error a definition has no runtime call entry
length.create(parent, 'hello');
// @ts-expect-error the bound entry retains its concrete input
bindings.get(length).create(parent, 123);
// @ts-expect-error a bound A still requires an O parent
bindings.get(leaf).create(parent, 'hello');
const alternative = new InvocationEntry(leaf, (_parent, value: number) => String(value));
const alternativeOutput: Promise<string> = bindings.entry(alternative).create(operation, 1).run();
void alternativeOutput;
// @ts-expect-error alternative entry enforces its own input contract
bindings.entry(alternative).create(operation, 'wrong');

// Contracts also support typed objects; no inheritance or synthetic identity is required.
const objectDefinition: OperationDefinition<string, number> = {
  level: 'operation',
  name: 'length',
  label: 'length',
  source: 'test',
  children: [],
  maxRounds: 1,
  raises: [],
  run: { requires: {}, execute: (context) => context.currentInput.length },
};
const objectOutput: Promise<Readonly<{ length: number }>> = new Sequence<string, typeof parent>().step('length', { use: objectDefinition, input: ({ input }) => input }).run(parent, 'hello', bindings);
void objectOutput;
declare const execution: ExecutionDefinition<string, number>;
declare const runtimeParent: InvocationView<unknown, unknown, RuntimeContextView>;
const runtimeDefinition: RuntimeDefinition<string, number> = {
  level: 'runtime',
  children: [execution],
  maxRounds: 1,
  raises: [],
  run: {
    requires: {},
    async execute(context, invocation, children) {
      const child = children.get(execution).create(invocation, context.currentInput);
      const output = await child.run();
      return children.accept(child, () => output);
    },
  },
};
const runtime = assembleRuntime(runtimeDefinition, { providers: [], source: { entry: () => null, capture: (_input, _options: { signal?: AbortSignal }) => null } });
const rootOutput: Promise<number> = runtime.run('input', {});
void rootOutput;
// @ts-expect-error R input retains its own declared contract
runtime.run(42, {});
// @ts-expect-error R cannot register A as an E
assembleRuntime({ ...runtimeDefinition, children: [leaf] }, { providers: [], source: { entry: () => null, capture: () => null } });
// @ts-expect-error R cannot call O directly
bindings.get(length).create(runtimeParent, 'input');
// @ts-expect-error E cannot be a direct child of O
bindings.get(execution).create(operation, 'input');
// @ts-expect-error E entry input retains its concrete type
bindings.get(execution).create(runtimeParent, 42);
// @ts-expect-error content cannot mutate its lifecycle
parent.context.complete('done');
// @ts-expect-error child relations do not publish reception mutation
parent.children.values()[0].accept(() => null);

import { ExceptionContract, ResourceOffer, type InvocationRunDefinition, type InvocationExceptionDefinition } from '@capix/server-runtime';
const issue = new ExceptionContract<{ reason: string }>('test.issue');
const workValue = new ResourceOffer('work-value', (value: number) => value);
const handlingValue = new ResourceOffer('handling-value', (value: string) => value);
type WorkContextView = OperationContextView<string, string, { value: number }>;
type HandlingContextView = OperationContextView<string, string, { repair: string }>;
const run: InvocationRunDefinition<string, string, WorkContextView, { value: number }> = {
  requires: { value: workValue.request() },
  execute(context) {
    const value: number = context.resources.values.value;
    // @ts-expect-error work does not acquire the handler's resource aliases
    context.resources.values.repair;
    return String(value);
  },
};
const exceptions: InvocationExceptionDefinition<string, string, HandlingContextView, { repair: string }> = {
  requires: { repair: handlingValue.request() },
  accepts: [issue],
  handle(context) {
    const repair: string = context.resources.values.repair;
    // @ts-expect-error handling does not implicitly inherit work aliases
    context.resources.values.value;
    return { kind: 'return', output: repair };
  },
};
const composed: OperationDefinition<string, string, { value: number }, { repair: string }> = {
  level: 'operation',
  name: 'typed',
  label: 'typed',
  source: 'test',
  children: [],
  maxRounds: 1,
  raises: [issue],
  run,
  exceptions,
};
const composedResult: Promise<string> = bindings.get(composed).call(parent, 'input');
void composedResult;

const childFacts = bindings.get(leaf).create(operation, 'input');
// @ts-expect-error child call facts do not grant its resources to the parent
childFacts.context.resources;

import { defineObservation, type InvocationFact, type RuntimeStructureFact, type ObservationDefinition, type ObservationDeclaration } from '@capix/server-runtime';
const counter = new ResourceOffer('counter', (value: { increment(): void }) => value);
const callProbe: ObservationDeclaration<InvocationFact> = defineObservation<InvocationFact, { counter: { increment(): void } }>({
  requires: { counter: counter.request() },
  observe(fact, ports) {
    if (fact.kind === 'started') ports.counter.increment();
    // @ts-expect-error an observer receives only its requested resource aliases
    ports.history;
    // @ts-expect-error observation ports are a readonly view of the requested resources
    ports.counter = { increment() {} };
    // @ts-expect-error invocation observations retain their fact contract
    fact.runtimeId;
    return undefined;
  },
});
// @ts-expect-error structure facts and per-call facts are different observation contracts
const structureProbe: ObservationDeclaration<RuntimeStructureFact> = callProbe;
// @ts-expect-error declarations do not own per-invocation resource binding
callProbe.bind;
const wrongPortProbe: ObservationDefinition<InvocationFact, { counter: { increment(): void } }> = {
  requires: {
    // @ts-expect-error each requested resource must supply its declared port type
    counter: workValue.request(),
  },
  observe: () => undefined,
};
const asynchronousProbe: ObservationDefinition<InvocationFact, Record<string, never>> = {
  requires: {},
  // @ts-expect-error asynchronous observation cannot retain the synchronous resource window
  observe: async () => undefined,
};
void structureProbe;
void asynchronousProbe;
void wrongPortProbe;
