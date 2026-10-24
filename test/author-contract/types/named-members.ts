import { Group, Node, Scene, ResourceOffer } from '@capix/server-runtime';
const primary = new Node<number, string>({ run: (w) => String(w.input) });
const backup = new Node<string, number>({ run: (w) => w.input.length });
new Group<number, string>().add({ primary, backup }).setRun(async (work) => {
  const output: string = await work.children.primary.invoke(3);
  const transformed: number = await work.children.primary.invoke(3, { result: { succeeded: (value) => value.length } });
  const fallback: boolean = await work.children.primary.invoke(3, { result: { succeeded: (value) => value.length > 0, failed: () => false } });
  // @ts-expect-error no unregistered name
  work.children.missing;
  // @ts-expect-error named input is exact
  work.children.primary.invoke('wrong');
  // @ts-expect-error output is string
  const wrong: number = await work.children.primary.invoke(3);
  return output;
});
new Group<number, string>().add({ primary, backup }).setRun(
  async (work) => {
    // @ts-expect-error no names outside explicit empty uses
    work.children.primary;
    return '';
  },
  {},
  { uses: [] },
);
new Group<number, string>().add({ primary, backup }).setRun(
  async (work) => {
    // @ts-expect-error no names outside explicit uses
    work.children.backup;
    return work.children.primary.invoke(1);
  },
  {},
  { uses: [primary] },
);
const g = new Group<number, string>().add({ primary }).add({ backup });
g.setRun(async (work) => `${await work.children.primary.invoke(1)}:${await work.children.backup.invoke('two')}`);
new Scene<number, string>().add({ g }).setRun((work) => work.children.g.invoke(1));
// @ts-expect-error reserved protocol name
new Group().add({ create: primary });
// @ts-expect-error wrong structural kind
new Group().add({ root: new Scene() });
new Group<number, string>({
  run(work) {
    // @ts-expect-error no backwards inference from later add
    work.children.primary;
    return '';
  },
}).add({ primary });
const count = new ResourceOffer('count', (x: number) => x);
new Group<number, string>().add({ primary }).setRun(
  (work) => {
    const n: number = work.resources.count;
    return work.children.primary.invoke(n);
  },
  { count: count.request() },
);

const streamed = new Node<number, string, {}, {}, string>({
  output: { result: (value) => String(value), delta: (value) => String(value) },
  run(work) {
    work.output.emit('delta');
    return String(work.input);
  },
});
new Group<number, string>().add({ streamed }).setRun((work) =>
  work.children.streamed.invoke(1, {
    delta(value) {
      const text: string = value;
      // @ts-expect-error delta retains the child output stream type
      const bad: number = value;
    },
  }),
);
// @ts-expect-error unknown names cannot be introduced by an add array
new Group().add(primary).setRun((work) => work.children.primary.invoke(1));
const symbolName = Symbol('member');
// @ts-expect-error names are string keys
new Group().add({ [symbolName]: primary });
// @ts-expect-error empty name
new Group().add({ '': primary });

const unrefined = new Group<number, string>();
unrefined.add({ primary });
unrefined.setRun((work) => {
  // @ts-expect-error registration refinement is returned, not retroactively applied to aliases
  work.children.primary;
  return '';
});
