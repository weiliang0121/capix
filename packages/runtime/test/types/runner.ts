import { Runner, Resources, Interactions, Scene, Node, callableHooks, type InteractionChannel, type InteractionContract } from '@weiliang0121/capix-runtime';
import { ResourceOffer } from '@weiliang0121/capix-resources';

declare function expectType<Value>(value: Value): void;

interface Input {
  readonly text: string;
}
interface Result {
  readonly length: number;
}
interface Options {
  readonly tenant: string;
}
interface Delta {
  readonly text: string;
}

const scene = new Scene<Input, Result>({ run: (work) => ({ length: work.input.text.length }) });
const resources = new Resources();
const runner = new Runner(scene, resources).build();
expectType<typeof runner>(runner.build());
expectType<typeof scene>(runner.scene);
expectType<boolean>(runner.isRunning);
expectType<Promise<Result>>(runner.run({ text: 'hello' }));
expectType<Promise<Result>>(runner.run({ text: 'hello' }, { signal: new AbortController().signal }));
expectType<Promise<Result>>(runner.resume('context'));
// @ts-expect-error Resources is required even if no ports are requested
new Runner(scene);
// @ts-expect-error Runner roots are Scenes, not Nodes
new Runner(new Node<Input, Result>(), resources);
// @ts-expect-error Runner does not select a scene at each run
runner.run(scene, { text: 'hello' });
// @ts-expect-error configured input stays exact
runner.run({ text: 123 });
// @ts-expect-error result type comes from the scene
expectType<Promise<string>>(runner.run({ text: 'hello' }));
// @ts-expect-error options do not introduce undeclared host parameters
runner.run({ text: 'hello' }, { tenant: 'unexpected' });

const interactions = new Interactions();
new Runner(scene, resources, interactions);
// @ts-expect-error the optional third entity is Interactions
new Runner(scene, resources, {});
const tenantResources = new Resources<Options>();
const tenantRunner = new Runner(scene, tenantResources).build();
expectType<Promise<Result>>(tenantRunner.run({ text: 'hello' }, { tenant: 'one' }));
expectType<Promise<Result>>(tenantRunner.resume('saved', { tenant: 'one' }));
// @ts-expect-error required resource capture options cannot be omitted
tenantRunner.run({ text: 'hello' });
// @ts-expect-error recovery must supply the same required host options
tenantRunner.resume('saved');
// @ts-expect-error options retain their declared field types
tenantRunner.run({ text: 'hello' }, { tenant: 1 });

const number = new ResourceOffer<number, number>({ name: 'runner.number', expose: (value) => value });
resources.register(number, 3);
// @ts-expect-error fixed supply is checked against the resource source type
resources.register(number, '3');
const text = new ResourceOffer<string, string>({ name: 'runner.text', expose: (value) => value });
const scope = tenantResources.capture(scene, (input, options) => {
  expectType<Input>(input);
  expectType<Options>(options);
  // @ts-expect-error capture sees the actual structure input
  input.path;
  // @ts-expect-error capture cannot invent host fields
  options.account;
  return { number: input.text.length, text: options.tenant };
});
scope.register(number, (snapshot) => {
  expectType<string>(snapshot.text);
  return snapshot.number;
});
scope.register(text, (snapshot) => snapshot.text);
// @ts-expect-error selector has to provide the resource's source type
scope.register(number, (snapshot) => snapshot.text);
// @ts-expect-error group capture cannot return a Promise
tenantResources.capture(scene, async (input) => ({ number: input.text.length }));
// @ts-expect-error grouped selectors remain synchronous
scope.register(number, async (snapshot) => snapshot.number);

const files = new ResourceOffer<{ root: string }, { root: string }, string>({
  name: 'runner.files',
  expose: (value) => value,
  timing: 'access',
  refine(value, path) {
    return { root: `${value.root}/${path}` };
  },
});
const leaf = new Node<{ path: string }, string>();
const refinement = files.refine((input: { path: string }) => input.path);
resources.refine(leaf, refinement);
resources.refine(
  leaf,
  // @ts-expect-error a refinement consumes this child's input, not an unrelated input
  files.refine((input: { index: number }) => String(input.index)),
);
// @ts-expect-error only child structures have a parent-supplied scope to refine
resources.refine(scene, refinement);

interface Request {
  readonly prompt: string;
}
interface Reply {
  readonly content: string;
}
declare const modelContract: InteractionContract<Request, Reply>;
declare const wrongRequest: InteractionContract<number, Reply>;
declare const wrongReply: InteractionContract<Request, number>;
const models = new ResourceOffer<InteractionChannel<Request, Reply>, InteractionChannel<Request, Reply>>({ name: 'runner.models', expose: (channel) => channel });
resources.registerInteraction(models, modelContract);
// @ts-expect-error request contract must match the resource's interaction channel
resources.registerInteraction(models, wrongRequest);
// @ts-expect-error reply contract must match the resource's interaction channel
resources.registerInteraction(models, wrongReply);
interactions.register(modelContract, {
  send(request) {
    expectType<Readonly<Request>>(request);
    return { content: request.prompt };
  },
});
// @ts-expect-error registered send must produce the declared reply
interactions.register(modelContract, { send: () => ({ content: 123 }) });

const streaming = new Scene<Input, Result, {}, Delta>();
const hooks = callableHooks<typeof streaming, Options>(streaming, {
  validate(input, options) {
    expectType<Input>(input);
    expectType<Options>(options);
  },
  started(input, options) {
    expectType<Input>(input);
    expectType<Options>(options);
    return (context, invocation) => {
      expectType<Input>(context.input);
      expectType<Promise<Result>>(invocation.run());
    };
  },
  output(input, options) {
    expectType<Input>(input);
    expectType<Options>(options);
    return {
      receive(event) {
        if (event.kind === 'delta') {
          expectType<Delta>(event.delta);
          // @ts-expect-error output deltas retain the scene's declared type
          expectType<number>(event.delta);
        }
        if (event.kind === 'completed') expectType<Result>(event.result);
      },
    };
  },
});
new Runner(streaming, tenantResources, interactions, {
  hooks: [hooks],
  validate(options) {
    expectType<Options>(options);
  },
});
callableHooks(streaming, {
  // @ts-expect-error hook input annotations cannot replace the actual structure input
  validate(input: number) {
    void input;
  },
});
callableHooks(streaming, {
  // @ts-expect-error started callbacks cannot be async
  started: () => async () => undefined,
});
callableHooks(streaming, {
  // @ts-expect-error started callback factories cannot be async either
  started: async () => () => undefined,
});
callableHooks(streaming, {
  // @ts-expect-error per-call validation must be synchronous
  validate: async () => undefined,
});
callableHooks(streaming, {
  // @ts-expect-error call hooks do not supply or capture resources
  capture: () => 'not a source',
});
new Runner(streaming, tenantResources, undefined, {
  // @ts-expect-error host validation must be synchronous
  validate: async () => undefined,
});
const tooNarrow = callableHooks<typeof streaming, Options & { readonly admin: true }>(streaming, {
  validate(_input, options) {
    expectType<true>(options.admin);
  },
});
new Runner(streaming, tenantResources, undefined, {
  // @ts-expect-error hook requirements cannot silently enlarge the configured host options
  hooks: [tooNarrow],
});
new Runner(streaming, tenantResources, undefined, {
  // @ts-expect-error host validation cannot require an undeclared option either
  validate(options: Options & { readonly admin: true }) {
    void options;
  },
});
