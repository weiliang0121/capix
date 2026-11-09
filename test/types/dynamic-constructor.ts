import { Dynamic, Node, Group, Scene, type CallableInput, type CallableOutput, type DynamicDecision } from '@weiliang0121/capix-structure';
import { Runner, Resources } from '@weiliang0121/capix-runtime';

declare function expectType<Value>(value: Value): void;
const read = new Node<{ path: string }, { text: string }>();
const save = new Node<{ text: string }, number>();
const options = { read, save };
const decide = new Node<{ request: string }, DynamicDecision<typeof options, { saved: number }>>();
const dynamic = new Dynamic({ options, decide, maxSteps: 8 });
expectType<Group<{ request: string }, { saved: number }>>(dynamic);
expectType<{ request: string }>(null! as CallableInput<typeof dynamic>);
expectType<{ saved: number }>(null! as CallableOutput<typeof dynamic>);
const scene = new Scene<{ request: string }, { saved: number }>().add({ dynamic });
scene.run = (work) => work.children.dynamic.invoke(work.input);
expectType<Promise<{ saved: number }>>(new Runner(scene, new Resources()).build().run({ request: 'save' }));
const immediate = new Dynamic({ options: {}, decide: new Node({ run: () => ({ kind: 'finish' as const, value: 42 }) }) });
expectType<Group<unknown, number>>(immediate);
const multiple = new Dynamic({ options, decide: new Node<string, DynamicDecision<typeof options, string | number>>() });
expectType<Group<string, string | number>>(multiple);
const onlyCalls = new Dynamic({ options, decide: new Node<string, { kind: 'call'; option: 'read'; input: { path: string } }>() });
expectType<never>(null! as CallableOutput<typeof onlyCalls>);
const composedDecision = new Group<string, { kind: 'finish'; value: boolean }>();
expectType<Group<string, boolean>>(new Dynamic({ options, decide: composedDecision }));

// @ts-expect-error unknown decision output has no checked call/finish contract
new Dynamic({ options, decide: new Node<string, unknown>() });
// @ts-expect-error missing candidate is rejected without widening the options from the decision
new Dynamic({ options, decide: new Node<string, { kind: 'call'; option: 'missing'; input: string }>() });
// @ts-expect-error candidate/input correspondence must survive constructor inference
new Dynamic({ options, decide: new Node<string, { kind: 'call'; option: 'save'; input: { path: string } }>() });
// @ts-expect-error independently unioned option and input do not form correlated decisions
new Dynamic({ options, decide: new Node<string, { kind: 'call'; option: 'read' | 'save'; input: { path: string } | { text: string } }>() });
// @ts-expect-error arbitrary successful node output is not a decision
new Dynamic({ options, decide: new Node<string, number>() });
// @ts-expect-error invalid decision kinds must be rejected
new Dynamic({ options, decide: new Node<string, { kind: 'next'; value: number }>() });
// @ts-expect-error finish needs its value, including explicit undefined
new Dynamic({ options, decide: new Node<string, { kind: 'finish' }>() });
// @ts-expect-error a scene cannot be a decision member
new Dynamic({ options, decide: new Scene<string, { kind: 'finish'; value: number }>() });
// @ts-expect-error a scene cannot be an action member
new Dynamic({ options: { scene: new Scene() }, decide });
// @ts-expect-error option keys retain registration constraints
new Dynamic({ options: { create: read }, decide: new Node<string, { kind: 'finish'; value: number }>() });

declare const incompatibleDecisions: Node<string, { kind: 'finish'; value: number }> | Node<number, { kind: 'finish'; value: number }>;
// @ts-expect-error an unresolved decision union cannot receive a union input safely
new Dynamic({ options, decide: incompatibleDecisions });
declare const compatibleDecisions: Node<string, { kind: 'finish'; value: number }> | Group<string, { kind: 'finish'; value: boolean }>;
expectType<Group<string, number | boolean>>(new Dynamic({ options, decide: compatibleDecisions }));
declare const incompatibleAction: Node<string, number> | Node<number, number>;
// @ts-expect-error an unresolved action union cannot accept just one alternative input
new Dynamic({ options: { action: incompatibleAction }, decide: new Node<string, { kind: 'call'; option: 'action'; input: string }>() });
// @ts-expect-error preset behavior cannot be replaced
dynamic.run = () => ({ saved: 1 });
// @ts-expect-error progression bound is fixed by construction
dynamic.maxSteps = 10;
// @ts-expect-error candidate set cannot be replaced incrementally
dynamic.options({ read });
// @ts-expect-error decision cannot be replaced incrementally
dynamic.decide(decide);
// @ts-expect-error no reverse-reference decision helper remains
dynamic.decisions.finish({ saved: 1 });
// @ts-expect-error construction requires a complete configuration
new Dynamic();
