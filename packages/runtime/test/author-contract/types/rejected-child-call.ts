/** Deliberately fails: child input and registered child contracts stay exact. */
import { defineNode, defineGroup } from '@weiliang0121/capix-runtime';

const child = defineNode<{ readonly path: string }, string>()({ name: 'child', label: 'Child', source: 'test', run: (work) => work.input.path });
defineGroup<string, string>()({
  name: 'bad-input',
  label: 'Parent',
  source: 'test',
  members: [child],
  run(work) {
    work.children.create(child, 1);
    return '';
  },
});
const other = defineNode<number, number>()({ run: (work) => work.input });
defineGroup<string, string>()({
  members: [child],
  run(work) {
    work.children.invoke(other, 1);
    return '';
  },
});
