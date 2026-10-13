import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { ExecutionDefinition, RuntimeError, type InvocationWorkView, type ExecutionContextView, type ChildBindings } from '@capix/server-runtime';
import type { GenerationOutput, ConversationTask } from '@capix/protocol';
import { conversationExecutionRequests, conversationEntryRequests, type ConversationExecutionResources, type ConversationEntryResources } from './resources.js';
import { prepareMemoryInput } from './operations/memory/input.js';
import type { SelectHistoryDefinition } from './operations/history/select.js';
import type { ExtractMemoryDefinition } from './operations/memory/extract.js';
import { acceptConversationRequest, type AcceptedConversationInput } from './accept.js';
import { prepareConversationSegment } from './admission.js';
import type { GenerateAnswerDefinition } from './operations/answer/generate.js';
import { answerStream, type AnswerProgress, type AnswerGenerationEvent } from './operations/answer/stream.js';
import { ProcessDocumentDefinition } from './operations/document/process.js';
import { SaveResultDefinition } from './operations/document/save.js';
import { CheckFileTaskDefinition } from './operations/preflight/check.js';
import type { Selection } from './model/types.js';
import { modelTextSchema } from './model/schema.js';
import type { ConversationDecisionDefinition, ConversationDecisionFeedback, ConversationDecisionProgress, ConversationDelivery } from './decision/types.js';
import { acceptConversationDecision, conversationCapability, reviseDecision, type ConversationCapability } from './decision/capability.js';

export interface ConversationOperationDefinitions {
  readonly selection: SelectHistoryDefinition;
  readonly generation: GenerateAnswerDefinition;
  readonly extraction: ExtractMemoryDefinition;
  readonly decision: ConversationDecisionDefinition;
  readonly preflight?: CheckFileTaskDefinition;
  readonly document?: ProcessDocumentDefinition;
  readonly save?: SaveResultDefinition;
}

interface ExecutionProgress extends ConversationDecisionProgress {
  readonly latest?: ConversationDelivery;
  readonly response?: ReturnType<ConversationExecutionResources['messages']['append']>[number];
}
type Context = ExecutionContextView<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources>;
type Call = InvocationWorkView<AcceptedConversationInput, GenerationOutput, Context, AnswerProgress>;
const emptyArguments = z.strictObject({});
const path = z.string().min(1).max(1024);
const output = z.strictObject({ path });
const fileArguments = z.strictObject({ task: z.union([z.strictObject({ sourcePath: path, output: output.optional() }), z.strictObject({ output })]), instruction: modelTextSchema });

/** E admits decisions and child deliveries. All evolving business state belongs to this call. */
export class ConversationExecutionDefinition extends ExecutionDefinition<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources, unknown, ConversationEntryResources, Record<string, never>, AnswerProgress> {
  readonly output = { result: answerStream.result, delta: (value: unknown) => value as AnswerProgress };
  readonly observation = [invocationRecording<AcceptedConversationInput, GenerationOutput>({ input: ({ message, fileTask }) => ({ ...message, ...(fileTask ? { fileTask } : {}) }) })];
  readonly run;
  readonly entry;
  readonly children;
  readonly maxDecisionSteps: number;

  constructor(
    readonly operationDefinitions: ConversationOperationDefinitions,
    options: { readonly maxDecisionSteps?: number } = {},
  ) {
    super();
    const fileDefinitions = [operationDefinitions.document, operationDefinitions.save, operationDefinitions.preflight].filter(Boolean).length;
    if (fileDefinitions !== 0 && fileDefinitions !== 3) throw new Error('File conversation requires preflight, document processing and save declarations');
    this.maxDecisionSteps = options.maxDecisionSteps ?? 8;
    if (!Number.isSafeInteger(this.maxDecisionSteps) || this.maxDecisionSteps < 1 || this.maxDecisionSteps > 16) throw new RangeError('Decision steps must be an integer between 1 and 16');
    this.children = Object.freeze(Object.values(operationDefinitions).filter((definition) => definition !== undefined));
    this.entry = {
      requires: conversationEntryRequests,
      accept: (input: unknown, resources: ConversationEntryResources) => acceptConversationRequest(input, resources.messages.append, Boolean(operationDefinitions.document)),
      admit: (input: AcceptedConversationInput, resources: ConversationEntryResources) => prepareConversationSegment(input.message, resources),
    };
    this.run = { requires: { ...conversationExecutionRequests, ...(operationDefinitions.preflight ? CheckFileTaskDefinition.requires : {}), ...(operationDefinitions.document ? ProcessDocumentDefinition.requires : {}), ...(operationDefinitions.save ? SaveResultDefinition.requires : {}) }, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: Context, invocation: Call, children: ChildBindings): Promise<GenerationOutput> {
    const { message, fileTask } = context.currentInput;
    const resources = context.resources.values;
    const memories = resources.memories;
    const selection = children.get(this.operationDefinitions.selection).create(invocation, { message, memories }, { key: 'selection' });
    await selection.run();
    const selected = await children.accept(selection, (delivered) => {
      resources.selectionUsage.add(delivered.historyIndexes.map((index) => resources.history.read(index)));
      return delivered;
    });
    const capabilities = this.capabilities(context, invocation, children, selected);
    const checkedCandidates = new Set<string>();
    let state: ExecutionProgress = Object.freeze({});
    let feedback: ConversationDecisionFeedback | undefined;
    for (let step = 0; step < this.maxDecisionSteps; step++) {
      children.requireActive();
      const decision = children.get(this.operationDefinitions.decision).create(
        invocation,
        {
          request: { message, selection: structuredClone(selected), memories: structuredClone(memories), ...(fileTask ? { fileTask: structuredClone(fileTask) } : {}) },
          ...structuredClone({
            progress: { ...(state.file ? { file: state.file } : {}), ...(state.answer ? { answer: state.answer } : {}), ...(state.saved ? { saved: state.saved } : {}) },
            ...(state.latest ? { latest: state.latest } : {}),
            available: [...capabilities.values()].filter((entry) => entry.available(state)).map((entry) => entry.offer),
            ...(feedback ? { feedback } : {}),
          }),
        },
        { key: 'decision' },
      );
      await decision.run();
      const choice = await children.accept(decision, (delivered) => {
        const accepted = acceptConversationDecision(delivered, capabilities, state, (conclusion) => (conclusion.kind === 'settled' ? Boolean(state.answer && (!state.file?.task.output || state.answer.kind !== 'answer' || state.saved)) : !state.answer));
        if (accepted.kind === 'invoke' && accepted.capability === 'checkFile') {
          const signature = JSON.stringify(fileArguments.parse(accepted.arguments));
          if (checkedCandidates.has(signature)) return reviseDecision('REPEATED_CANDIDATE', '该文件候选已检查过，请使用已有反馈修改候选或提出具体问题，不重复检查相同候选。');
          checkedCandidates.add(signature);
        }
        return accepted;
      });
      if (choice.kind === 'revise') {
        feedback = choice.feedback;
        continue;
      }
      feedback = undefined;
      if (choice.kind === 'finish') {
        if (choice.conclusion.kind !== 'settled') {
          const answer: GenerationOutput = choice.conclusion.kind === 'clarify' ? { kind: 'needs-info', content: choice.conclusion.question } : { kind: 'unknown', content: choice.conclusion.explanation };
          resources.tasks.select({ kind: choice.conclusion.kind });
          resources.messages.append([{ role: 'assistant', content: answer.content }]);
          return answer;
        }
        const extraction = children.get(this.operationDefinitions.extraction).create(invocation, prepareMemoryInput(resources.history, state.response!, selected.historyIndexes, memories, { saved: state.saved }), { key: 'extraction' });
        await extraction.run();
        await children.accept(extraction, (delivered) => delivered);
        return state.answer!;
      }
      state = await capabilities.get(choice.capability)!.run(choice.arguments, state);
    }
    throw new RuntimeError('DECISION_LIMIT', '本轮决策未能在限定步数内完成，已落实的消息和文件保留。');
  }

  private capabilities(context: Context, invocation: Call, children: ChildBindings, selection: Selection): ReadonlyMap<string, ConversationCapability<ExecutionProgress>> {
    const resources = context.resources.values;
    const definitions = this.operationDefinitions;
    const input = (state: ExecutionProgress) => ({ selection, memories: resources.memories, ...(state.file ? { task: { fileTask: state.file.task, instruction: state.file.instruction } } : {}) });
    const selectTask = (state: ExecutionProgress) => {
      const task: ConversationTask = state.file ? { kind: 'file', task: state.file.task } : { kind: 'reply' };
      resources.tasks.select(task);
    };
    let candidate: Extract<AnswerGenerationEvent, { kind: 'completed' }> | undefined;
    const receiveGeneration = (event: AnswerGenerationEvent): undefined => {
      if (event.kind === 'started' || event.kind === 'discarded') candidate = undefined;
      if (event.kind === 'completed' && !event.discarded) candidate = event;
      invocation.output.emit({ kind: 'generation', event });
    };
    const receiveAnswer = (answer: GenerationOutput, state: ExecutionProgress, capability: 'answer' | 'document'): ExecutionProgress => {
      const response = resources.messages.append([{ role: 'assistant', content: answer.content }])[0]!;
      if (candidate?.result === answer) invocation.output.emit({ kind: 'committed', source: { contextId: candidate.contextId, round: candidate.round }, message: { transcriptId: resources.history.transcriptId, index: response.index }, content: answer.content });
      return Object.freeze({ ...state, answer, response, latest: { capability, output: answer } });
    };
    const entries: ConversationCapability<ExecutionProgress>[] = [
      conversationCapability(
        {
          name: 'answer',
          description: '根据当前目标生成回答；若已有预检通过的保存目标，回答正文可在后续保存。内部自行构造历史、记忆和模型输入。',
          use: definitions.generation,
          key: 'generation',
          output: { receive: receiveGeneration },
          schema: emptyArguments,
          available: (state: ExecutionProgress) => !state.answer && state.file?.task.sourcePath === undefined && (!context.currentInput.fileTask || Boolean(state.file)),
          input: (_arguments, state) => {
            selectTask(state);
            return input(state);
          },
          accept: (delivered, state) => receiveAnswer(delivered, state, 'answer'),
        },
        invocation,
        children,
      ),
    ];
    if (definitions.preflight && definitions.document && definitions.save) {
      const preflight = definitions.preflight;
      const document = definitions.document;
      const save = definitions.save;
      entries.push(
        conversationCapability(
          {
            name: 'checkFile',
            description: '检查用户指定的文本来源和新文件保存目标；支持根内绝对路径转相对路径。只检查环境事实，不读取正文、不写入、不保证随后执行成功。',
            use: preflight,
            key: 'preflight',
            schema: fileArguments,
            available: (state: ExecutionProgress) => !state.answer && !state.file,
            input: (arguments_) => arguments_,
            accept: (delivered, state): ExecutionProgress => Object.freeze({ ...state, ...(delivered.kind === 'ready' ? { file: delivered } : {}), latest: { capability: 'checkFile' as const, output: delivered } }),
          },
          invocation,
          children,
        ),
        conversationCapability(
          {
            name: 'document',
            description: '读取已通过预检的来源文本并完成内容处理。只使用父层已接纳的目标，模型不能另选路径。',
            use: document,
            key: 'generation',
            output: {
              receive: (event): undefined => {
                if (event.kind === 'delta') receiveGeneration(event.delta);
              },
            },
            schema: emptyArguments,
            available: (state: ExecutionProgress) => !state.answer && state.file?.task.sourcePath !== undefined,
            input: (_arguments, state) => {
              selectTask(state);
              return { ...input(state), sourcePath: state.file!.task.sourcePath! };
            },
            accept: (delivered, state) => receiveAnswer(delivered, state, 'document'),
          },
          invocation,
          children,
        ),
        conversationCapability(
          {
            name: 'save',
            description: '把本轮已正式接纳的回答保存到已预检的目标新文件，返回真实创建凭据。不能自行提供或更改路径、正文。',
            use: save,
            key: 'save',
            schema: emptyArguments,
            available: (state: ExecutionProgress) => state.answer?.kind === 'answer' && Boolean(state.file?.task.output) && !state.saved,
            input: (_arguments, state) => ({ path: state.file!.task.output!.path, text: state.answer!.content }),
            accept: (delivered, state): ExecutionProgress => Object.freeze({ ...state, saved: delivered, latest: { capability: 'save' as const, output: delivered } }),
          },
          invocation,
          children,
        ),
      );
    }
    return new Map(entries.map((entry) => [entry.offer.name, entry]));
  }
}
