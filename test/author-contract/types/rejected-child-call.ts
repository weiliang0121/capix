/** Deliberately fails without expect-error: uses and child input must be real constraints. */
import { defineNode, defineGroup } from '@capix/server-runtime';

const child = defineNode<{ readonly path: string }, string>()({ name: 'child', label: 'Child', source: 'test', callee: 'test', run: { execute: (work) => work.input.path } });
defineGroup<string, string>()({
  name: 'bad-input',
  label: 'Parent',
  source: 'test',
  members: [child],
  run: {
    execute(work) {
      work.children.create(child, 1);
      return '';
    },
  },
});
defineGroup<string, string>()({
  name: 'no-uses',
  label: 'Parent',
  source: 'test',
  members: [child],
  run: {
    uses: [],
    execute(work) {
      work.children.create(child, { path: 'x' });
      return '';
    },
  },
});
