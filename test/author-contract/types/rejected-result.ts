/** Deliberately fails: explicit Output is not widened to match the implementation. */
import { defineNode } from '@capix/server-runtime';

defineNode<string, string>()({ name: 'wrong-result', label: 'Leaf', source: 'test', callee: 'test', run: () => 42 });
