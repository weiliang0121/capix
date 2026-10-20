import { Driver, defineNode, defineScene, type BoundCallable, type CheckpointStore } from '@capix/server-runtime';

const node = defineNode<number, number>()({ run: { execute: (work) => work.input } });
const driver = new Driver();
const bound = driver.bind(node, {
  providers: [],
  source: {
    capture(_input: number, options: { tenantId: string }) {
      return options.tenantId.toUpperCase();
    },
  },
});
const output: Promise<number> = driver.run(bound, 1, { tenantId: 'tenant', signal: new AbortController().signal });
const resumed: Promise<number> = driver.resume(bound, 'saved-call', { tenantId: 'tenant' });
const scope = bound.begin({ tenantId: 'tenant' });
const directOutput: Promise<number> = bound.createRoot(1, scope, {}).run();
const running: boolean = driver.isRunning(bound);
const checkpoints: CheckpointStore | undefined = driver.checkpointStore;

// @ts-expect-error Binding retains the required source options at the Driver boundary.
driver.run(bound, 1, {});
// @ts-expect-error Resume cannot omit the same source requirement.
driver.resume(bound, 'saved-call', {});
// @ts-expect-error A caller cannot omit required source options by entering the Bound directly.
bound.begin({});
// @ts-expect-error A typed option cannot be substituted by another primitive.
driver.run(bound, 1, { tenantId: 42 });
// @ts-expect-error Source options cannot be widened by explicitly weakening the Driver method.
driver.run<number, number, Record<string, never>, unknown>(bound, 1, {});
// @ts-expect-error Erasing the options contract cannot make a source callable without its input.
const erased: BoundCallable<number, number> = bound;
// @ts-expect-error The callable input is still independent from the source options.
driver.run(bound, 'wrong input', { tenantId: 'tenant' });
// @ts-expect-error A surrounding result annotation cannot change the declared output.
const wrongOutput: Promise<string> = driver.run(bound, 1, { tenantId: 'tenant' });
// @ts-expect-error A Driver has no current bound input/output specialization.
new Driver<number, number>();
// @ts-expect-error A bound callable is not the Driver mechanism configuration.
new Driver(bound);
// @ts-expect-error Driver does not expose a global current entry or occupancy.
driver.running;
// @ts-expect-error Entry occupation is internal; callers run an actual bound callable.
driver.reserve(() => null);

const scene = defineScene<string, string>()({ run: { execute: (work) => work.input } });
const other = driver.bind(scene, {
  providers: [],
  source: {
    capture(_input: string, options: { documentId: number }) {
      return options.documentId;
    },
  },
});
const otherOutput: Promise<string> = driver.run(other, 'document', { documentId: 42 });
// @ts-expect-error A different binding retains its independent option contract.
driver.run(other, 'document', { tenantId: 'tenant' });
// @ts-expect-error Binding source input cannot change the definition's declared input.
driver.bind(node, { providers: [], source: { capture: (_input: string) => null } });

const unconstrained = driver.bind(node, { providers: [], source: { capture: () => null } });
const simpleOutput: Promise<number> = driver.run(unconstrained, 1, {});
void [output, resumed, directOutput, running, checkpoints, erased, wrongOutput, otherOutput, simpleOutput];
