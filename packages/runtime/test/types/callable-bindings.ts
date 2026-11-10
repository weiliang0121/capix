import { Driver, Group, Node, defineNode, defineScene, type BuiltCallable, type BuiltOptions } from '@weiliang0121/capix-runtime';
import { type CheckpointStore } from '@weiliang0121/capix-checkpoint';

import { createRootInvocation } from '@weiliang0121/capix-runtime/construction';

const node = defineNode<number, number>()({ run: (work) => work.input });
const driver = new Driver();
const bound = driver.build(node, {
  providers: [],
  source: {
    capture(_input: number, options: { tenantId: string }) {
      return options.tenantId.toUpperCase();
    },
  },
});
const output: Promise<number> = driver.run(bound, 1, { tenantId: 'tenant', signal: new AbortController().signal });
const resumed: Promise<number> = driver.resume(bound, 'saved-call', { tenantId: 'tenant' });
const original: typeof node = bound;
const requiredOptions: BuiltOptions<typeof bound> = { tenantId: 'tenant' };
const directOutput: Promise<number> = createRootInvocation(bound, 1, { tenantId: 'tenant' }, {}).run();
const running: boolean = driver.isRunning(bound);
const checkpoints: CheckpointStore | undefined = driver.checkpointStore;

// @ts-expect-error Binding retains the required source options at the Driver boundary.
driver.run(bound, 1, {});
// @ts-expect-error Resume cannot omit the same source requirement.
driver.resume(bound, 'saved-call', {});
// @ts-expect-error Low-level construction preserves the same required source options.
createRootInvocation(bound, 1, {}, {});
// @ts-expect-error A typed option cannot be substituted by another primitive.
driver.run(bound, 1, { tenantId: 42 });
// @ts-expect-error Source options cannot be widened by explicitly weakening the Driver method.
driver.run<BuiltCallable<typeof node, unknown>>(bound, 1, {});
// @ts-expect-error Erasing the options contract cannot make a source callable without its input.
const erased: BuiltCallable<typeof node, unknown> = bound;
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

const scene = defineScene<string, string>()({ run: (work) => work.input });
const other = driver.build(scene, {
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
driver.build(node, { providers: [], source: { capture: (_input: string) => null } });

const simpleNode = defineNode<number, number>()({ run: (work) => work.input });
const unconstrained = driver.build(simpleNode, { providers: [], source: { capture: () => null } });
const simpleOutput: Promise<number> = driver.run(unconstrained, 1, {});
void [original, requiredOptions, output, resumed, directOutput, running, checkpoints, erased, wrongOutput, otherOutput, simpleOutput];

// The required build marker is independent from a structure's callable signature.
const unbuilt = new Node<number, number>({ run: (work) => work.input });
// @ts-expect-error A configured structure has not installed its runtime capability.
driver.run(unbuilt, 1, {});
// @ts-expect-error Restoration also requires a built structure.
driver.resume(unbuilt, 'saved-call', {});
// @ts-expect-error Occupancy is defined only for a built entry owned by the Driver.
driver.isRunning(unbuilt);
// @ts-expect-error Low-level creation cannot silently build an unprepared structure.
createRootInvocation(unbuilt, 1, {}, {});
// @ts-expect-error The original alias does not statically acquire the returned build marker.
driver.run(node, 1, { tenantId: 'tenant' });

class NamedGroup extends Group<number, string> {
  readonly purpose = 'format';
  readonly child = new Node<number, string>({ run: (work) => String(work.input) });

  constructor() {
    super();
    this.add(this.child);
    this.run = (work) => work.children.invoke(this.child, work.input);
  }
}
const authored = new NamedGroup();
const builtGroup = driver.build(authored, { providers: [], source: { capture: () => null } });
const sameClass: NamedGroup = builtGroup;
const purpose: 'format' = builtGroup.purpose;
const ownChild: typeof authored.child = builtGroup.child;
const groupOutput: Promise<string> = driver.run(builtGroup, 42, {});
// @ts-expect-error Building preserves the concrete input rather than widening to unknown.
driver.run(builtGroup, 'wrong', {});
// @ts-expect-error Building preserves a subclass output rather than widening to unknown.
const wrongGroupOutput: Promise<number> = driver.run(builtGroup, 42, {});
void [sameClass, purpose, ownChild, groupOutput, wrongGroupOutput];
