/** Deliberately fails: explicit Output is not widened to match the implementation. */
import { defineNode } from '@weiliang0121/capix-runtime';

defineNode<string, string>()({ name: 'wrong-result', label: 'Leaf', source: 'test', run: () => 42 });
