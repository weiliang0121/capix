import { isSafeInteger } from 'es-toolkit/compat';
import type { Selection } from '../../../shared/types.js';
import type { Message } from '../../../shared/transcript/message.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { AttemptContext } from '../../context/attempt.js';
import { Operation } from '../operation.js';

export interface GenerationInput {
  readonly message: Readonly<Message>;
  readonly selectedMessages: readonly { index: number; message: Readonly<Message> }[];
}

export function assembleContext(execution: ExecutionContext, selection: Selection): GenerationInput {
  const range = execution.transcriptRange;
  if (!range || range.length === 0) throw new Error('Execution Transcript range is required');
  const selectedMessages = selection.historyIndexes.map((index) => {
    if (!isSafeInteger(index) || index < range.start || index >= range.end - 1) throw new RangeError('Selected message is outside the execution history');
    return Object.freeze({ index, message: range.read(index) });
  });
  return Object.freeze({ message: execution.input as Readonly<Message>, selectedMessages: Object.freeze(selectedMessages) });
}

export class AssembleContext extends Operation<Selection, Selection, GenerationInput, GenerationInput> {
  readonly name = 'assemble';
  readonly label = '组装上下文';
  readonly source = 'src/server/operations/context/assemble.ts · AssembleContext';
  protected readonly phaseSource = 'src/server/operations/context/assemble.ts';

  before(input: Selection): Selection {
    return input;
  }
  commit(input: Selection, context: AttemptContext<Selection, GenerationInput>): GenerationInput {
    return assembleContext(this.runtime.getExecutionContext(context), input);
  }
  after(input: GenerationInput): GenerationInput {
    return input;
  }
}
