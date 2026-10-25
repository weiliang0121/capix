import { Group, Node, Scene, ResourceOffer } from '@capix/server-runtime';
const primary = new Node<number, string>({ run: (w) => String(w.input) });
const backup = new Node<string, number>({ run: (w) => w.input.length });
const group = new Group<number, string>().add({ primary, backup });
group.run = async (work) => {
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
};
const g = new Group<number, string>().add({ primary }).add({ backup });
g.run = async (work) => `${await work.children.primary.invoke(1)}:${await work.children.backup.invoke('two')}`;
const scene = new Scene<number, string>().add({ g });
scene.run = (work) => work.children.g.invoke(1);
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
const count = new ResourceOffer({ name: 'count', expose: (x: number) => x });
const resources = new Group<number, string, { count: number }>().add({ primary });
resources.deps = { count: count.request() };
resources.run = (work) => {
  const n: number = work.resources.count;
  return work.children.primary.invoke(n);
};
const streamed = new Node<number, string, {}, string>({
  output: { result: (value) => String(value), delta: (value) => String(value) },
  run(work) {
    work.output.emit('delta');
    return String(work.input);
  },
});
const streaming = new Group<number, string>().add({ streamed });
streaming.run = (work) =>
  work.children.streamed.invoke(1, {
    delta(value) {
      const text: string = value;
      // @ts-expect-error delta retains the child output stream type
      const bad: number = value;
    },
  });
const unnamed = new Group().add(primary);
// @ts-expect-error array registration does not create named access
unnamed.run = (work) => work.children.primary.invoke(1);
const symbolName = Symbol('member');
// @ts-expect-error names are string keys
new Group().add({ [symbolName]: primary });
// @ts-expect-error empty name
new Group().add({ '': primary });
const unrefined = new Group<number, string>();
unrefined.add({ primary });
unrefined.run = (work) => {
  // @ts-expect-error names are known on the add return value
  work.children.primary;
  return '';
};
