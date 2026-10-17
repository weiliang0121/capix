/** Deliberately fails: explicit Output is not widened to match the implementation. */
import { defineAttempt } from '@capix/server-runtime';

defineAttempt<string, string>()({ name: 'wrong-result', label: 'Leaf', source: 'test', callee: 'test', run: { execute: () => 42 } });
