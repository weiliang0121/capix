/** Deliberately fails without expect-error: uses and child input must be real constraints. */
import { defineAttempt, defineOperation } from '@capix/server-runtime';

const child = defineAttempt<{ readonly path: string }, string>()({ name: 'child', label: 'Child', source: 'test', callee: 'test', run: { execute: (work) => work.input.path } });
defineOperation<string, string>()({
  name: 'bad-input',
  label: 'Parent',
  source: 'test',
  children: [child],
  run: {
    execute(work) {
      work.children.create(child, 1);
      return '';
    },
  },
});
defineOperation<string, string>()({
  name: 'no-uses',
  label: 'Parent',
  source: 'test',
  children: [child],
  run: {
    uses: [],
    execute(work) {
      work.children.create(child, { path: 'x' });
      return '';
    },
  },
});
