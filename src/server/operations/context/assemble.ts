import type { Selection } from '../../../shared/types.js';
import type { SelectionInput } from '../history/input.js';
import type { MessageRef } from '../../transcript/ref.js';
import { identity, type Operation } from '../operation.js';
import type { NodeDefinition } from '../../node.js';

export const assembleContextDefinition = {
  name: 'assemble',
  label: '组装上下文',
  source: 'src/server/operations/context/assemble.ts · assembleContextOperation',
  phaseSource: 'src/server/operations/context/assemble.ts',
} as const satisfies NodeDefinition;

export interface AssemblyInput {
  original: SelectionInput;
  selection: Selection;
}

export function assembleContext(input: SelectionInput, selection: Selection) {
  return Object.freeze({
    query: input.query,
    messages: Object.freeze(selection.historyIndexes.map((index) => input.historyRange.ref(index))),
  });
}
export interface AnswerInput {
  readonly query: MessageRef;
  readonly messages: readonly MessageRef[];
}

export const assembleContextOperation: Operation<AssemblyInput, AssemblyInput, AnswerInput, AnswerInput> = {
  before: identity,
  commit: ({ original, selection }) => assembleContext(original, selection),
  after: identity,
};
