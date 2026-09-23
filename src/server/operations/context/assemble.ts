import type { Selection } from '../../../shared/types.js';
import type { Message } from '../../../shared/transcript/message.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { AttemptContext } from '../../context/attempt.js';
import { Operation, type OperationDefinition } from '../operation.js';
import type { Runtime } from '../../runtime/runtime.js';

export const assembleContextDefinition = {
  name: 'assemble',
  label: '组装上下文',
  source: 'src/server/operations/context/assemble.ts · AssembleContext',
  phaseSource: 'src/server/operations/context/assemble.ts',
} as const satisfies OperationDefinition;

export interface GenerationInput {
  readonly query: Readonly<Message>;
  readonly messages: readonly { index: number; message: Readonly<Message> }[];
}

export function assembleContext(execution: ExecutionContext, selection: Selection): GenerationInput {
  const range = execution.transcriptRange;
  if (!range || range.length === 0) throw new Error('Execution Transcript range is required');
  const messages = selection.historyIndexes.map((index) => {
    if (!Number.isSafeInteger(index) || index < range.start || index >= range.end - 1) throw new RangeError('Selected message is outside the execution history');
    return Object.freeze({ index, message: range.read(index) });
  });
  return Object.freeze({ query: execution.input as Readonly<Message>, messages: Object.freeze(messages) });
}

export class AssembleContext extends Operation<Selection, Selection, GenerationInput, GenerationInput> {
  constructor(runtime: Runtime) {
    super(runtime, assembleContextDefinition);
  }
  before(input: Selection): Selection {
    return input;
  }
  commit(input: Selection, context: AttemptContext): GenerationInput {
    return assembleContext(this.runtime.getExecutionContext(context), input);
  }
  after(output: GenerationInput): GenerationInput {
    return output;
  }
}
