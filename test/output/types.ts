import { Node, Group, type NodeWork, type GroupWork, type ChildCalls, type OutputDeclaration } from '@capix/server-runtime';
import type { InvocationOutputEvent, InvocationOutputReceiver } from '@capix/structure';
import { ProgressChannel } from '@capix/server-runtime';

// The output port keeps its original generic receiver shape across the package seam.
declare const receiver: InvocationOutputReceiver<string, number>;
declare const event: InvocationOutputEvent<string, number>;
const channel = new ProgressChannel(receiver);
channel.publish(event);
// @ts-expect-error the receiver still determines Delta without an explicit channel annotation
channel.publish({ contextId: 'call', round: 1, sequence: 0, kind: 'delta', delta: 'wrong' });

const text: OutputDeclaration<string, string> = {
  result(value) {
    if (typeof value !== 'string') throw new Error('text');
    return value;
  },
  delta(value) {
    if (typeof value !== 'string') throw new Error('text');
    return value;
  },
};
class Leaf extends Node<string, string, Record<string, never>, string> {
  name = 'leaf';
  label = 'Leaf';
  source = 'test';
  readonly output = text;
  readonly deps = {};
  readonly run = function (work: NodeWork<string, string, Record<string, never>, string>) {
    work.output.emit(work.input);
    // @ts-expect-error only declared string deltas may be emitted
    work.output.emit(42);
    return work.input;
  };
}
class Parent extends Group<string, string, Record<string, never>, string> {
  name = 'parent';
  label = 'Parent';
  source = 'test';
  readonly leaf = new Leaf();
  constructor() {
    super();
    this.add(this.leaf);
  }
  readonly output = text;
  readonly deps = {};
  readonly run = async (work: GroupWork<string, string, Record<string, never>, Leaf, string>) => {
    const call = work.children.create(this.leaf, work.input, {
      output: {
        receive(event) {
          if (event.kind === 'delta') {
            const value: string = event.delta;
            work.output.emit(value);
          }
        },
      },
    });
    // @ts-expect-error child calls do not have producing endpoints
    call.output.emit('borrow');
    await call.run();
    return call.accept();
  };
}
void new Parent();
declare const typed: Node<string, string, Record<string, never>, string>;
declare const children: ChildCalls<typeof typed>;
children.create(typed, 'input', {
  output: {
    receive(event) {
      if (event.kind === 'delta') {
        const value: string = event.delta;
        void value;
      }
    },
  },
});
