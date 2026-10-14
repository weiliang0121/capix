import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { ExecutionDefinition, RuntimeError, type InvocationWorkView, type ExecutionContextView, type ChildBindings, type InvocationCheckpointDefinition, type InvocationCheckpointFrame, type ChildInvocationView } from '@capix/server-runtime';
import { isEqual } from 'es-toolkit';
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
import type { ConversationDecisionDefinition } from './decision/types.js';
import { acceptConversationDecision, conversationCapability, reviseDecision, type ConversationCapability } from './decision/capability.js';
import { checkpointCodec, checkpointChild, decisionAcceptanceSchema, executionProgressSchema, acceptedCheckpointInput, conversationCheckpointOutput, executionWaitingState, executionDecisionState, executionCapabilityState, executionAcceptedState, type ExecutionProgress, type ExecutionContinuation, type ExecutionWaitingState, type ExecutionDecisionState, type ExecutionCapabilityState } from './checkpoint.js';

export interface ConversationOperationDefinitions {
  readonly selection: SelectHistoryDefinition;
  readonly generation: GenerateAnswerDefinition;
  readonly extraction: ExtractMemoryDefinition;
  readonly decision: ConversationDecisionDefinition;
  readonly preflight?: CheckFileTaskDefinition;
  readonly document?: ProcessDocumentDefinition;
  readonly save?: SaveResultDefinition;
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
  readonly checkpoint: InvocationCheckpointDefinition<AcceptedConversationInput, GenerationOutput, Context, AnswerProgress>;

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
    this.checkpoint = {
      key: 'observer.conversation.execution',
      version: 2,
      input: acceptedCheckpointInput,
      output: conversationCheckpointOutput,
      points: {
        selectionWaiting: {
          state: checkpointCodec(checkpointChild),
          check: (frame, state) => {
            const child = this.checkChild(frame, state.childId, 'selection', this.operationDefinitions.selection);
            if (frame.children.length !== 1 || !isEqual((child.input as { message?: unknown }).message, acceptedCheckpointInput.decode(frame.currentInput).message)) throw new Error('Selection continuation changed the admitted message');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.receiveSelection(context, invocation, children, children.get(this.operationDefinitions.selection).resume(invocation, state.childId)) },
        },
        selectionAccepted: {
          state: executionAcceptedState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            this.checkChild(frame, state.childId, 'selection', this.operationDefinitions.selection, 'accepted');
            if (frame.children.length !== 1) throw new Error('Selection continuation contains later work');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.advance(context, invocation, children, state) },
        },
        decisionWaiting: {
          state: executionWaitingState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            this.checkChild(frame, state.childId, 'decision', this.operationDefinitions.decision);
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.receiveDecision(context, invocation, children, state, children.get(this.operationDefinitions.decision).resume(invocation, state.childId)) },
        },
        decisionAccepted: {
          state: executionDecisionState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            const child = this.checkChild(frame, state.childId, 'decision', this.operationDefinitions.decision, 'accepted');
            if (child.state.kind !== 'returned' || child.state.reception.kind !== 'accepted' || !isEqual(child.state.reception.output, { choice: state.choice, progress: state.progress, checkedCandidates: state.checkedCandidates })) throw new Error('Decision continuation differs from its accepted proposal');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.afterDecision(context, invocation, children, state) },
        },
        capabilityWaiting: {
          state: executionCapabilityState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            const definition = this.capabilityDefinition(state.capability);
            const child = this.checkChild(frame, state.childId, this.capabilityKey(state.capability), definition);
            this.checkCapabilityInput(frame, state, child.input);
            const decision = frame.children.at(-2);
            if (decision?.key !== 'decision' || decision.state.kind !== 'returned' || decision.state.reception.kind !== 'accepted' || !isEqual(decisionAcceptanceSchema.parse(decision.state.reception.output).choice, { kind: 'invoke', capability: state.capability, arguments: state.arguments })) throw new Error('Capability continuation differs from the accepted decision');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.receiveCapability(context, invocation, children, state, this.capabilities(context, invocation, children, state.selection).get(state.capability)!.resume(state.childId)) },
        },
        answerAccepted: {
          state: executionAcceptedState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            this.checkChild(frame, state.childId, 'generation', this.capabilityDefinition(state.progress.latest?.capability ?? ''), 'accepted');
            if (!state.progress.answer || !['answer', 'document'].includes(state.progress.latest?.capability ?? '')) throw new Error('Answer continuation requires the accepted generation');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.advance(context, invocation, children, state) },
        },
        capabilityAccepted: {
          state: executionAcceptedState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            const name = state.progress.latest?.capability;
            if (name !== 'checkFile' && name !== 'save') throw new Error('Capability continuation requires preflight or save');
            this.checkChild(frame, state.childId, this.capabilityKey(name), this.capabilityDefinition(name), 'accepted');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.advance(context, invocation, children, state) },
        },
        extractionWaiting: {
          state: executionWaitingState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            this.checkChild(frame, state.childId, 'extraction', this.operationDefinitions.extraction);
            this.checkSettledDecision(frame.children.at(-2));
            if (!state.progress.answer || !state.progress.response) throw new Error('Memory continuation requires an accepted answer');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (context, invocation, children, state) => this.receiveExtraction(context, invocation, children, state, children.get(this.operationDefinitions.extraction).resume(invocation, state.childId)) },
        },
        completed: {
          state: executionAcceptedState,
          check: (frame, state) => {
            this.checkProgress(frame, state);
            this.checkChild(frame, state.childId, 'extraction', this.operationDefinitions.extraction, 'accepted');
            if (!state.progress.answer) throw new Error('Completed conversation requires its answer');
            this.checkSettledDecision(frame.children.at(-2));
          },
          resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, state) => state.progress.answer! },
        },
      },
    };
  }

  private async execute(context: Context, invocation: Call, children: ChildBindings): Promise<GenerationOutput> {
    const child = children.get(this.operationDefinitions.selection).create(invocation, { message: context.currentInput.message, memories: context.resources.values.memories }, { key: 'selection' });
    invocation.checkpoint?.save('selectionWaiting', { childId: child.context.id });
    return this.receiveSelection(context, invocation, children, child);
  }

  private async receiveSelection(context: Context, invocation: Call, children: ChildBindings, child: ChildInvocationView<any, Selection>): Promise<GenerationOutput> {
    await child.run();
    const selection = await children.accept(child, (delivered) => {
      context.resources.values.selectionUsage.add(delivered.historyIndexes.map((index) => context.resources.values.history.read(index)));
      return delivered;
    });
    const state = { childId: child.context.id, selection, progress: {}, step: 0, checkedCandidates: [] };
    invocation.checkpoint?.save('selectionAccepted', state);
    return this.advance(context, invocation, children, state);
  }

  private async advance(context: Context, invocation: Call, children: ChildBindings, state: ExecutionContinuation): Promise<GenerationOutput> {
    state = { selection: state.selection, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates, ...(state.feedback ? { feedback: state.feedback } : {}) };
    children.requireActive();
    if (state.step >= this.maxDecisionSteps) throw new RuntimeError('DECISION_LIMIT', '本轮决策未能在限定步数内完成，已落实的消息和文件保留。');
    const { message, fileTask } = context.currentInput;
    const progress = state.progress;
    const capabilities = this.capabilities(context, invocation, children, state.selection);
    const child = children.get(this.operationDefinitions.decision).create(
      invocation,
      {
        request: { message, selection: structuredClone(state.selection), memories: structuredClone(context.resources.values.memories), ...(fileTask ? { fileTask: structuredClone(fileTask) } : {}) },
        ...structuredClone({ progress: { ...(progress.file ? { file: progress.file } : {}), ...(progress.answer ? { answer: progress.answer } : {}), ...(progress.saved ? { saved: progress.saved } : {}) }, ...(progress.latest ? { latest: progress.latest } : {}), available: [...capabilities.values()].filter((entry) => entry.available(progress)).map((entry) => entry.offer), ...(state.feedback ? { feedback: state.feedback } : {}) }),
      },
      { key: 'decision' },
    );
    const waiting = { ...state, childId: child.context.id };
    if (this.operationDefinitions.decision.checkpoint) invocation.checkpoint?.save('decisionWaiting', waiting);
    return this.receiveDecision(context, invocation, children, waiting, child);
  }

  private async receiveDecision(context: Context, invocation: Call, children: ChildBindings, state: ExecutionWaitingState, child: ChildInvocationView<any, any>): Promise<GenerationOutput> {
    await child.run();
    const capabilities = this.capabilities(context, invocation, children, state.selection);
    const accepted = await children.accept(child, (delivered) => {
      const checked = new Set(state.checkedCandidates);
      let progress = state.progress;
      let choice = acceptConversationDecision(delivered, capabilities, progress, (conclusion) => (conclusion.kind === 'settled' ? Boolean(progress.answer && (!progress.file?.task.output || progress.answer.kind !== 'answer' || progress.saved)) : !progress.answer));
      if (choice.kind === 'invoke' && choice.capability === 'checkFile') {
        const signature = JSON.stringify(fileArguments.parse(choice.arguments));
        if (checked.has(signature)) choice = reviseDecision('REPEATED_CANDIDATE', '该文件候选已检查过，请使用已有反馈修改候选或提出具体问题，不重复检查相同候选。');
        else checked.add(signature);
      }
      if (choice.kind === 'finish' && choice.conclusion.kind !== 'settled') {
        const answer: GenerationOutput = choice.conclusion.kind === 'clarify' ? { kind: 'needs-info', content: choice.conclusion.question } : { kind: 'unknown', content: choice.conclusion.explanation };
        context.resources.values.tasks.select({ kind: choice.conclusion.kind });
        progress = { ...progress, ...this.appendAnswer(context, invocation, answer, child.context.id) };
      }
      return { choice, progress, checkedCandidates: [...checked] };
    });
    const next = { ...state, ...accepted } as ExecutionDecisionState;
    invocation.checkpoint?.save('decisionAccepted', next);
    return this.afterDecision(context, invocation, children, next);
  }

  private async afterDecision(context: Context, invocation: Call, children: ChildBindings, state: ExecutionDecisionState): Promise<GenerationOutput> {
    const choice = state.choice;
    if (choice.kind === 'revise') return this.advance(context, invocation, children, { ...state, step: state.step + 1, feedback: choice.feedback });
    if (choice.kind === 'finish') {
      if (choice.conclusion.kind !== 'settled') return state.progress.answer!;
      const child = children.get(this.operationDefinitions.extraction).create(invocation, prepareMemoryInput(context.resources.values.history, state.progress.response!, state.selection.historyIndexes, context.resources.values.memories, { saved: state.progress.saved }), { key: 'extraction' });
      const waiting = { selection: state.selection, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates, childId: child.context.id };
      invocation.checkpoint?.save('extractionWaiting', waiting);
      return this.receiveExtraction(context, invocation, children, waiting, child);
    }
    const capability = this.capabilities(context, invocation, children, state.selection).get(choice.capability)!;
    const child = capability.create(choice.arguments, state.progress);
    const waiting: ExecutionCapabilityState = { selection: state.selection, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates, childId: child.context.id, capability: choice.capability, arguments: choice.arguments };
    invocation.checkpoint?.save('capabilityWaiting', waiting);
    return this.receiveCapability(context, invocation, children, waiting, child, capability);
  }

  private async receiveCapability(context: Context, invocation: Call, children: ChildBindings, state: ExecutionCapabilityState, child: ChildInvocationView<any, any>, capability = this.capabilities(context, invocation, children, state.selection).get(state.capability)!): Promise<GenerationOutput> {
    await child.run();
    const progress = await capability.accept(child, state.progress);
    const next = { selection: state.selection, progress, step: state.step + 1, checkedCandidates: state.checkedCandidates, childId: child.context.id };
    invocation.checkpoint?.save(state.capability === 'answer' || state.capability === 'document' ? 'answerAccepted' : 'capabilityAccepted', next);
    return this.advance(context, invocation, children, next);
  }

  private async receiveExtraction(_context: Context, invocation: Call, children: ChildBindings, state: ExecutionWaitingState, child: ChildInvocationView<any, any>): Promise<GenerationOutput> {
    await child.run();
    await children.accept(child, (delivered) => delivered);
    invocation.checkpoint?.save('completed', state);
    return state.progress.answer!;
  }

  private appendAnswer(context: Context, invocation: Call, answer: GenerationOutput, childId: string): Pick<ExecutionProgress, 'answer' | 'response' | 'receipt' | 'responseChildId'> {
    if (invocation.checkpoint) {
      const receipt = context.resources.values.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: answer.content }] });
      return { answer, response: { index: receipt.start, message: { role: 'assistant', content: answer.content } }, receipt: { ...receipt, count: 1 }, responseChildId: childId };
    }
    return { answer, response: context.resources.values.messages.append([{ role: 'assistant', content: answer.content }])[0]! };
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
    const receiveAnswer = (answer: GenerationOutput, state: ExecutionProgress, capability: 'answer' | 'document', childId: string): ExecutionProgress => {
      const accepted = this.appendAnswer(context, invocation, answer, childId);
      const response = accepted.response!;
      if (candidate?.result === answer) invocation.output.emit({ kind: 'committed', source: { contextId: candidate.contextId, round: candidate.round }, message: { transcriptId: resources.history.transcriptId, index: response.index }, content: answer.content });
      return Object.freeze({ ...state, ...accepted, latest: { capability, output: answer } });
    };
    const entries: ConversationCapability<ExecutionProgress>[] = [
      {
        offer: { name: 'answer', description: '根据当前目标生成回答；若已有预检通过的保存目标，回答正文可在后续保存。内部自行构造历史、记忆和模型输入。', arguments: z.toJSONSchema(emptyArguments) },
        use: definitions.generation,
        available: (state: ExecutionProgress) => !state.answer && (!state.file || !('sourcePath' in state.file.task)) && (!context.currentInput.fileTask || Boolean(state.file)),
        validate: (value: unknown) => emptyArguments.safeParse(value).success,
        create: (value: unknown, state: ExecutionProgress) => {
          emptyArguments.parse(value);
          selectTask(state);
          return children.get(definitions.generation).create(invocation, input(state), { key: 'generation', output: { receive: receiveGeneration } });
        },
        resume: (contextId) => children.get(definitions.generation).resume(invocation, contextId),
        accept: (child, state) => children.accept(child, (answer) => receiveAnswer(answer, state, 'answer', child.context.id)),
      },
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
            available: (state: ExecutionProgress) => !state.answer && Boolean(state.file && 'sourcePath' in state.file.task),
            input: (_arguments, state) => {
              selectTask(state);
              return { ...input(state), sourcePath: 'sourcePath' in state.file!.task ? state.file!.task.sourcePath : '' };
            },
            accept: (delivered, state, child) => receiveAnswer(delivered, state, 'document', child.context.id),
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

  private capabilityDefinition(name: string) {
    const definition = name === 'answer' ? this.operationDefinitions.generation : name === 'checkFile' ? this.operationDefinitions.preflight : name === 'document' ? this.operationDefinitions.document : name === 'save' ? this.operationDefinitions.save : undefined;
    if (!definition) throw new Error('Checkpoint capability is not declared');
    return definition;
  }
  private capabilityKey(name: string): string {
    return name === 'checkFile' ? 'preflight' : name === 'save' ? 'save' : 'generation';
  }

  private checkChild(frame: InvocationCheckpointFrame, id: string, key: string, definition: { checkpoint?: { key: string; version: number } }, status: 'waiting' | 'accepted' = 'waiting') {
    const child = frame.children.at(-1);
    if (frame.round !== 1 || !isEqual(frame.input, frame.currentInput) || !child || child.identity.contextId !== id || child.key !== key || child.contract?.key !== definition.checkpoint?.key || child.contract?.version !== definition.checkpoint?.version) throw new Error('Conversation continuation must identify its exact declared child');
    if (status === 'waiting' ? child.state.kind !== 'waiting' : child.state.kind !== 'returned' || child.state.reception.kind !== 'accepted') throw new Error('Conversation continuation has the wrong child reception stage');
    return child;
  }

  private checkSettledDecision(child: InvocationCheckpointFrame['children'][number] | undefined): void {
    if (!child || child.key !== 'decision' || child.state.kind !== 'returned' || child.state.reception.kind !== 'accepted' || !isEqual(decisionAcceptanceSchema.parse(child.state.reception.output).choice, { kind: 'finish', conclusion: { kind: 'settled' } })) throw new Error('Memory continuation requires the accepted settled decision');
  }

  private checkCapabilityInput(frame: InvocationCheckpointFrame, state: ExecutionCapabilityState, actual: unknown): void {
    const progress = state.progress;
    const generation = { selection: state.selection, memories: (frame.children[0]!.input as { memories: unknown }).memories, ...(progress.file ? { task: { fileTask: progress.file.task, instruction: progress.file.instruction } } : {}) };
    let expected: unknown;
    if (state.capability === 'checkFile') expected = state.arguments;
    else if (state.capability === 'save') {
      if (!progress.file?.task.output || progress.answer?.kind !== 'answer' || progress.saved) throw new Error('Save continuation has no accepted writable result');
      expected = { path: progress.file.task.output.path, text: progress.answer.content };
    } else if (state.capability === 'document') {
      if (!progress.file || !('sourcePath' in progress.file.task) || progress.answer) throw new Error('Document continuation has no accepted source');
      expected = { ...generation, sourcePath: progress.file.task.sourcePath };
    } else {
      if (progress.answer || (progress.file && 'sourcePath' in progress.file.task)) throw new Error('Answer continuation has a different accepted capability');
      expected = generation;
    }
    if (!isEqual(actual, expected)) throw new Error('Capability continuation changed its fixed input');
  }

  private checkProgress(frame: InvocationCheckpointFrame, state: ExecutionContinuation & { childId: string }): void {
    acceptedCheckpointInput.decode(frame.currentInput);
    const selection = frame.children[0];
    const last = frame.children.at(-1);
    if (frame.round !== 1 || state.step > this.maxDecisionSteps || !last || last.identity.contextId !== state.childId || selection?.key !== 'selection' || selection.state.kind !== 'returned' || selection.state.reception.kind !== 'accepted' || !isEqual(selection.state.output, state.selection) || !isEqual(selection.state.reception.output, state.selection)) throw new Error('Conversation continuation differs from its accepted history selection');
    const decisions = frame.children.filter((child) => child.key === 'decision');
    const count = decisions.length;
    const expectedStep = last.key === 'selection' ? 0 : last.key === 'decision' || last.key === 'extraction' || last.state.kind === 'waiting' ? count - 1 : count;
    if (state.step !== expectedStep) throw new Error('Conversation continuation has an inconsistent decision budget');
    let expectedProgress: ExecutionProgress = {};
    let expectedCandidates: string[] = [];
    for (const child of frame.children) {
      if (child.state.kind !== 'returned' || child.state.reception.kind !== 'accepted') continue;
      if (child.key === 'decision') {
        const accepted = decisionAcceptanceSchema.parse(child.state.reception.output);
        expectedProgress = accepted.progress;
        expectedCandidates = accepted.checkedCandidates;
      } else if (['preflight', 'generation', 'save'].includes(child.key ?? '')) expectedProgress = executionProgressSchema.parse(child.state.reception.output);
    }
    if (!isEqual(state.progress, expectedProgress) || !isEqual(state.checkedCandidates, expectedCandidates)) throw new Error('Conversation continuation differs from its latest accepted progress');
    if (last.key === 'decision' && !isEqual((last.input as { feedback?: unknown }).feedback, state.feedback)) throw new Error('Conversation continuation changed its decision feedback');
    const progress = state.progress;
    if (progress.answer) {
      const answerChild = frame.children.find((child) => child.identity.contextId === progress.responseChildId);
      if (!progress.receipt || !progress.response || progress.receipt.start !== progress.response.index || progress.response.message.role !== 'assistant' || progress.response.message.content !== progress.answer.content || !answerChild || answerChild.state.kind !== 'returned' || answerChild.state.reception.kind !== 'accepted') throw new Error('Conversation continuation has no accepted answer source');
      const source = answerChild.key === 'decision' ? decisionAcceptanceSchema.parse(answerChild.state.reception.output).progress : executionProgressSchema.parse(answerChild.state.reception.output);
      if (!isEqual(source?.answer, progress.answer) || !isEqual(source?.receipt, progress.receipt) || !isEqual(source?.response, progress.response) || source?.responseChildId !== progress.responseChildId) throw new Error('Conversation answer differs from its accepted entity receipt');
    } else if (progress.response || progress.receipt || progress.saved) throw new Error('Conversation progress has effects without an answer');
    if (progress.file) {
      const found = frame.children.some((child) => child.key === 'preflight' && child.state.kind === 'returned' && child.state.reception.kind === 'accepted' && isEqual(child.state.output, progress.file));
      if (!found) throw new Error('Conversation continuation has no accepted file preflight');
    }
    if (progress.saved && !frame.children.some((child) => child.key === 'save' && child.state.kind === 'returned' && child.state.reception.kind === 'accepted' && isEqual(child.state.output, progress.saved))) throw new Error('Conversation continuation has no accepted file receipt');
  }
}
