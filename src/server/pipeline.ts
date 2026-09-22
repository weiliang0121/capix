import { invoke } from './invocation/invoke.js';
import { MessageRef } from './transcript/ref.js';
import { selectionInput } from './operations/history/input.js';
import type { ModelSettings, Answer } from '../shared/types.js';
import type { RuntimeSnapshot } from '../shared/records.js';
import { registerNode } from './node.js';
import { assembleContextOperation, assembleContextDefinition } from './operations/context/assemble.js';
import { createGenerateAnswer, generateAnswerDefinition } from './operations/answer/generate.js';
import { createSelectHistory, selectHistoryDefinition } from './operations/history/select.js';
import type { ModelProvider } from './provider.js';
import { Clock } from './runtime/clock.js';
import { RecordBook, RecordIndex, type OperationRecord, type AttemptRecord } from './records/index.js';
import { RuntimeRecorder } from './records/recorder.js';
import type { ExecutionContext } from './context/execution.js';
import { Runtime } from './runtime/runtime.js';

export async function runPipeline(query: MessageRef, settings: ModelSettings, provider: ModelProvider, publish: (snapshot: RuntimeSnapshot) => void = () => {}, signal = new AbortController().signal): Promise<RuntimeSnapshot> {
  if (!(query instanceof MessageRef) || query.read().role !== 'user') throw new TypeError('Execution requires a user query reference');
  const transcript = query.transcript;

  const book = new RecordBook();
  const index = new RecordIndex<OperationRecord>((record) => record.executionId);
  const attempts = new RecordIndex<AttemptRecord>((record) => record.operationId);
  const recorder = new RuntimeRecorder(book, index, attempts, new Clock(), publish);
  const runtime = new Runtime(recorder);
  let execution: ExecutionContext<MessageRef, Answer> | undefined;
  try {
    await invoke(
      runtime.execution<MessageRef, Answer>({
        input: query,
        settings,
        signal,
        transcript,
      }),
      async (context) => {
        execution = context;
        const dependencies = { settings: context.settings, provider, signal: context.signal };
        const selectHistory = registerNode(() => createSelectHistory(dependencies), runtime, selectHistoryDefinition);
        const assemble = registerNode(() => assembleContextOperation, runtime, assembleContextDefinition);
        const generateAnswer = registerNode(() => createGenerateAnswer(dependencies), runtime, generateAnswerDefinition);
        const input = selectionInput(context.input);
        const selection = await selectHistory.call(context, input);
        const assembled = await assemble.call(context, { original: input, selection });
        const answer = await generateAnswer.call(context, assembled);
        context.transcript!.append({ role: 'assistant', content: answer.content });
        return answer;
      },
    );
  } catch (error) {
    // A recorded work failure is a pipeline result; registration failures must propagate.
    if (execution?.status !== 'failed') throw error;
    if (!recorder.hasOutcome(execution)) throw error;
    return recorder.snapshot(execution);
  }
  return recorder.snapshot(execution!);
}
