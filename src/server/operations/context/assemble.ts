import type { Selection } from '../../../shared/types.js';
import type { SelectionInput } from '../history/input.js';
import type { MessageRef } from '../../transcript/ref.js';
import { Operation, type OperationDefinition } from '../operation.js';
import type { Runtime } from '../../runtime/runtime.js';

export const assembleContextDefinition = {
  name: 'assemble',
  label: '组装上下文',
  source: 'src/server/operations/context/assemble.ts · AssembleContext',
  phaseSource: 'src/server/operations/context/assemble.ts',
} as const satisfies OperationDefinition;

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
export interface GenerationInput {
  readonly query: MessageRef;
  readonly messages: readonly MessageRef[];
}

export class AssembleContext extends Operation<AssemblyInput, AssemblyInput, GenerationInput, GenerationInput> {
  constructor(runtime: Runtime) {
    super(runtime, assembleContextDefinition);
  }
  before(input: AssemblyInput): AssemblyInput {
    return input;
  }
  commit({ original, selection }: AssemblyInput): GenerationInput {
    return assembleContext(original, selection);
  }
  after(output: GenerationInput): GenerationInput {
    return output;
  }
}
