import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { ExecutionDefinition, RuntimeError, checkpointPoint, childReference, type ExecutionWork, type ResumeWork, type ChildDefinition, type ChildCall, type ChildFact, type CheckpointFacts, type InvocationCheckpointPoint } from '@capix/server-runtime';
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
import { checkpointCodec, decisionAcceptanceSchema, executionProgressSchema, acceptedCheckpointInput, conversationCheckpointOutput, executionWaitingState, executionDecisionState, executionCapabilityState, executionAcceptedState, type ExecutionProgress, type ExecutionContinuation, type ExecutionWaitingState, type ExecutionDecisionState, type ExecutionCapabilityState } from './checkpoint.js';

export interface ConversationOperationDefinitions {
  readonly selection: SelectHistoryDefinition;
  readonly generation: GenerateAnswerDefinition;
  readonly extraction: ExtractMemoryDefinition;
  readonly decision: ConversationDecisionDefinition;
  readonly preflight?: CheckFileTaskDefinition;
  readonly document?: ProcessDocumentDefinition;
  readonly save?: SaveResultDefinition;
}

type Work = ExecutionWork<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources, ChildDefinition, AnswerProgress> | ResumeWork<'execution', AcceptedConversationInput, GenerationOutput, ConversationExecutionResources, ChildDefinition, AnswerProgress>;
type Facts = CheckpointFacts<AcceptedConversationInput>;
type Point = InvocationCheckpointPoint<AcceptedConversationInput, GenerationOutput, 'execution', any, any, any, any, AnswerProgress>;
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
  readonly checkpoint;
  readonly selectionWaiting;
  readonly selectionAccepted;
  readonly decisionWaiting;
  readonly decisionAccepted;
  readonly extractionWaiting;
  readonly completed;
  readonly capabilityWaiting = new Map<string, Point>();
  readonly capabilityAccepted = new Map<string, Point>();

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
    const point = checkpointPoint<'execution', AcceptedConversationInput, GenerationOutput, AnswerProgress>();
    this.selectionWaiting = point({
      name: 'selectionWaiting',
      state: checkpointCodec(z.strictObject({})),
      references: { active: childReference(operationDefinitions.selection) },
      check: (_state, facts) => {
        const child = this.checkChild(facts, facts.references.active, 'selection', operationDefinitions.selection);
        if (facts.children.values().length !== 1 || !isEqual((child.input as { message?: unknown }).message, facts.input.message)) throw new Error('Selection continuation changed the admitted message');
      },
      resume: { requires: this.run.requires, uses: this.children, execute: (work, _state, saved) => this.receiveSelection(work, work.children.resume(saved.active)) },
    });
    this.selectionAccepted = point({
      name: 'selectionAccepted',
      state: executionAcceptedState,
      references: { active: childReference(operationDefinitions.selection) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        this.checkChild(facts, facts.references.active, 'selection', operationDefinitions.selection, 'accepted');
        if (facts.children.values().length !== 1) throw new Error('Selection continuation contains later work');
      },
      resume: { requires: this.run.requires, uses: this.children, execute: (work, state) => this.advance(work, state) },
    });
    this.decisionWaiting = point({
      name: 'decisionWaiting',
      state: executionWaitingState,
      references: { active: childReference(operationDefinitions.decision) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        this.checkChild(facts, facts.references.active, 'decision', operationDefinitions.decision);
      },
      resume: { requires: this.run.requires, uses: this.children, execute: (work, state, saved) => this.receiveDecision(work, state, work.children.resume(saved.active)) },
    });
    this.decisionAccepted = point({
      name: 'decisionAccepted',
      state: executionDecisionState,
      references: { active: childReference(operationDefinitions.decision) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        const child = this.checkChild(facts, facts.references.active, 'decision', operationDefinitions.decision, 'accepted');
        if (child.reception.status !== 'accepted' || !isEqual(child.reception.value, { choice: state.choice, progress: state.progress, checkedCandidates: state.checkedCandidates })) throw new Error('Decision continuation differs from its accepted proposal');
      },
      resume: { requires: this.run.requires, uses: this.children, execute: (work, state) => this.afterDecision(work, state) },
    });
    for (const name of ['answer', ...(operationDefinitions.document ? ['checkFile', 'document', 'save'] : [])]) {
      const definition = this.capabilityDefinition(name);
      this.capabilityWaiting.set(
        name,
        point({
          name: `capabilityWaiting.${name}`,
          state: executionCapabilityState,
          references: { active: childReference(definition) },
          check: (state, facts) => {
            this.checkProgress(facts, state, facts.references.active);
            if (state.capability !== name) throw new Error('Capability checkpoint changed its declaration');
            const child = this.checkChild(facts, facts.references.active, this.capabilityKey(name), definition);
            this.checkCapabilityInput(facts, state, child.input);
            const decision = facts.children.values().at(-2);
            if (!decision) throw new Error('Capability continuation has no decision');
            facts.children.require(operationDefinitions.decision, decision.ref);
            if (decision.reception.status !== 'accepted' || !isEqual(decisionAcceptanceSchema.parse(decision.reception.value).choice, { kind: 'invoke', capability: state.capability, arguments: state.arguments })) throw new Error('Capability continuation differs from the accepted decision');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (work, state, saved) => this.receiveCapability(work, state, work.children.resume(saved.active)) },
        }),
      );
      this.capabilityAccepted.set(
        name,
        point({
          name: `capabilityAccepted.${name}`,
          state: executionAcceptedState,
          references: { active: childReference(definition) },
          check: (state, facts) => {
            this.checkProgress(facts, state, facts.references.active);
            this.checkChild(facts, facts.references.active, this.capabilityKey(name), definition, 'accepted');
            if (state.progress.latest?.capability !== name || ((name === 'answer' || name === 'document') && !state.progress.answer)) throw new Error('Capability continuation differs from its accepted result');
          },
          resume: { requires: this.run.requires, uses: this.children, execute: (work, state) => this.advance(work, state) },
        }),
      );
    }
    this.extractionWaiting = point({
      name: 'extractionWaiting',
      state: executionWaitingState,
      references: { active: childReference(operationDefinitions.extraction) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        this.checkChild(facts, facts.references.active, 'extraction', operationDefinitions.extraction);
        this.checkSettledDecision(facts);
        if (!state.progress.answer || !state.progress.response) throw new Error('Memory continuation requires an accepted answer');
      },
      resume: { requires: this.run.requires, uses: this.children, execute: (work, state, saved) => this.receiveExtraction(work, state, work.children.resume(saved.active)) },
    });
    this.completed = point({
      name: 'completed',
      state: executionAcceptedState,
      references: { active: childReference(operationDefinitions.extraction) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        this.checkChild(facts, facts.references.active, 'extraction', operationDefinitions.extraction, 'accepted');
        if (!state.progress.answer) throw new Error('Completed conversation requires its answer');
        this.checkSettledDecision(facts);
      },
      resume: { requires: {}, uses: [], execute: (_work, state) => state.progress.answer! },
    });
    this.checkpoint = { key: 'observer.conversation.execution', version: 3, input: acceptedCheckpointInput, output: conversationCheckpointOutput, points: [this.selectionWaiting, this.selectionAccepted, this.decisionWaiting, this.decisionAccepted, ...this.capabilityWaiting.values(), ...this.capabilityAccepted.values(), this.extractionWaiting, this.completed] };
  }

  private async execute(work: Work): Promise<GenerationOutput> {
    const child = work.children.create(this.operationDefinitions.selection, { message: work.input.message, memories: work.resources.memories }, { key: 'selection' });
    work.checkpoint?.save(this.selectionWaiting, {}, { active: child.ref });
    return this.receiveSelection(work, child);
  }

  private async receiveSelection(work: Work, child: ChildCall<SelectHistoryDefinition>): Promise<GenerationOutput> {
    await child.run();
    const selection = await child.accept((delivered) => {
      work.resources.selectionUsage.add(delivered.historyIndexes.map((index) => work.resources.history.read(index)));
      return delivered;
    });
    const state = { selection, progress: {}, step: 0, checkedCandidates: [] };
    work.checkpoint?.save(this.selectionAccepted, state, { active: child.ref });
    return this.advance(work, state);
  }

  private async advance(work: Work, state: ExecutionContinuation): Promise<GenerationOutput> {
    state = { selection: state.selection, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates, ...(state.feedback ? { feedback: state.feedback } : {}) };
    if (state.step >= this.maxDecisionSteps) throw new RuntimeError('DECISION_LIMIT', '本轮决策未能在限定步数内完成，已落实的消息和文件保留。');
    const { message, fileTask } = work.input;
    const progress = state.progress;
    const capabilities = this.capabilities(work, state.selection);
    const child = work.children.create(
      this.operationDefinitions.decision,
      {
        request: { message, selection: structuredClone(state.selection), memories: structuredClone(work.resources.memories), ...(fileTask ? { fileTask: structuredClone(fileTask) } : {}) },
        ...structuredClone({ progress: { ...(progress.file ? { file: progress.file } : {}), ...(progress.answer ? { answer: progress.answer } : {}), ...(progress.saved ? { saved: progress.saved } : {}) }, ...(progress.latest ? { latest: progress.latest } : {}), available: [...capabilities.values()].filter((entry) => entry.available(progress)).map((entry) => entry.offer), ...(state.feedback ? { feedback: state.feedback } : {}) }),
      },
      { key: 'decision' },
    );
    const waiting = { ...state };
    if (this.operationDefinitions.decision.checkpoint) work.checkpoint?.save(this.decisionWaiting, waiting, { active: child.ref });
    return this.receiveDecision(work, waiting, child);
  }

  private async receiveDecision(work: Work, state: ExecutionWaitingState, child: ChildCall<any>): Promise<GenerationOutput> {
    await child.run();
    const capabilities = this.capabilities(work, state.selection);
    const accepted = await child.accept((delivered) => {
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
        work.resources.tasks.select({ kind: choice.conclusion.kind });
        progress = { ...progress, ...this.appendAnswer(work, answer, work.children.facts.get(child.ref).order) };
      }
      return { choice, progress, checkedCandidates: [...checked] };
    });
    const next = { ...state, ...accepted } as ExecutionDecisionState;
    work.checkpoint?.save(this.decisionAccepted, next, { active: child.ref });
    return this.afterDecision(work, next);
  }

  private async afterDecision(work: Work, state: ExecutionDecisionState): Promise<GenerationOutput> {
    const choice = state.choice;
    if (choice.kind === 'revise') return this.advance(work, { ...state, step: state.step + 1, feedback: choice.feedback });
    if (choice.kind === 'finish') {
      if (choice.conclusion.kind !== 'settled') return state.progress.answer!;
      const child = work.children.create(this.operationDefinitions.extraction, prepareMemoryInput(work.resources.history, state.progress.response!, state.selection.historyIndexes, work.resources.memories, { saved: state.progress.saved }), { key: 'extraction' });
      const waiting = { selection: state.selection, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates };
      work.checkpoint?.save(this.extractionWaiting, waiting, { active: child.ref });
      return this.receiveExtraction(work, waiting, child);
    }
    const capability = this.capabilities(work, state.selection).get(choice.capability)!;
    const child = capability.create(choice.arguments, state.progress);
    const waiting: ExecutionCapabilityState = { selection: state.selection, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates, capability: choice.capability, arguments: choice.arguments };
    work.checkpoint?.save(this.capabilityWaiting.get(choice.capability)!, waiting, { active: child.ref });
    return this.receiveCapability(work, waiting, child, capability);
  }

  private async receiveCapability(work: Work, state: ExecutionCapabilityState, child: ChildCall<any>, capability = this.capabilities(work, state.selection).get(state.capability)!): Promise<GenerationOutput> {
    await child.run();
    const progress = await capability.accept(child, state.progress);
    const next = { selection: state.selection, progress, step: state.step + 1, checkedCandidates: state.checkedCandidates };
    work.checkpoint?.save(this.capabilityAccepted.get(state.capability)!, next, { active: child.ref });
    return this.advance(work, next);
  }

  private async receiveExtraction(work: Work, state: ExecutionWaitingState, child: ChildCall<any>): Promise<GenerationOutput> {
    await child.run();
    await child.accept((delivered) => delivered);
    work.checkpoint?.save(this.completed, state, { active: child.ref });
    return state.progress.answer!;
  }

  private appendAnswer(work: Work, answer: GenerationOutput, childOrder: number): Pick<ExecutionProgress, 'answer' | 'response' | 'receipt' | 'responseOrder'> {
    if (work.checkpoint) {
      const receipt = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: answer.content }] });
      return { answer, response: { index: receipt.start, message: { role: 'assistant', content: answer.content } }, receipt: { ...receipt, count: 1 }, responseOrder: childOrder };
    }
    return { answer, response: work.resources.messages.append([{ role: 'assistant', content: answer.content }])[0]! };
  }

  private capabilities(work: Work, selection: Selection): ReadonlyMap<string, ConversationCapability<ExecutionProgress>> {
    const resources = work.resources;
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
      work.output.emit({ kind: 'generation', event });
    };
    const receiveAnswer = (answer: GenerationOutput, state: ExecutionProgress, capability: 'answer' | 'document', childOrder: number): ExecutionProgress => {
      const accepted = this.appendAnswer(work, answer, childOrder);
      const response = accepted.response!;
      if (candidate?.result === answer) work.output.emit({ kind: 'committed', source: { contextId: candidate.contextId, round: candidate.round }, message: { transcriptId: resources.history.transcriptId, index: response.index }, content: answer.content });
      return Object.freeze({ ...state, ...accepted, latest: { capability, output: answer } });
    };
    const entries: ConversationCapability<ExecutionProgress>[] = [
      {
        offer: { name: 'answer', description: '根据当前目标生成回答；若已有预检通过的保存目标，回答正文可在后续保存。内部自行构造历史、记忆和模型输入。', arguments: z.toJSONSchema(emptyArguments) },
        use: definitions.generation,
        available: (state: ExecutionProgress) => !state.answer && (!state.file || !('sourcePath' in state.file.task)) && (!work.input.fileTask || Boolean(state.file)),
        validate: (value: unknown) => emptyArguments.safeParse(value).success,
        create: (value: unknown, state: ExecutionProgress) => {
          emptyArguments.parse(value);
          selectTask(state);
          return work.children.create(definitions.generation, input(state), { key: 'generation', output: { receive: receiveGeneration } });
        },
        accept: (child, state) => {
          const fact = work.children.facts.require(definitions.generation, child.ref);
          return work.children.open(fact.ref).accept((answer) => receiveAnswer(answer, state, 'answer', fact.order));
        },
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
          work.children,
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
            accept: (delivered, state, child) => receiveAnswer(delivered, state, 'document', work.children.facts.get(child.ref).order),
          },
          work.children,
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
          work.children,
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

  private checkChild(facts: Facts, selected: ChildFact, key: string, definition: ChildDefinition, status: 'waiting' | 'accepted' = 'waiting') {
    const child = facts.children.require(definition, selected.ref);
    if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input) || facts.children.values().at(-1)?.ref !== child.ref || child.key !== key) throw new Error('Conversation continuation must identify its exact declared child');
    if (status === 'waiting' ? child.returned !== undefined : child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted') throw new Error('Conversation continuation has the wrong child reception stage');
    return child;
  }

  private checkSettledDecision(facts: Facts): void {
    const child = facts.children.values().at(-2);
    if (!child) throw new Error('Memory continuation has no settled decision');
    facts.children.require(this.operationDefinitions.decision, child.ref);
    if (child.key !== 'decision' || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isEqual(decisionAcceptanceSchema.parse(child.reception.value).choice, { kind: 'finish', conclusion: { kind: 'settled' } })) throw new Error('Memory continuation requires the accepted settled decision');
  }

  private checkCapabilityInput(facts: Facts, state: ExecutionCapabilityState, actual: unknown): void {
    const progress = state.progress;
    const selection = facts.children.requireUnique(this.operationDefinitions.selection, { parentRound: 1 });
    const generation = { selection: state.selection, memories: selection.input.memories, ...(progress.file ? { task: { fileTask: progress.file.task, instruction: progress.file.instruction } } : {}) };
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

  private checkProgress(facts: Facts, state: ExecutionContinuation, active: ChildFact): void {
    const all = facts.children.values();
    const selection = facts.children.requireUnique(this.operationDefinitions.selection, { parentRound: 1 });
    const last = all.at(-1);
    if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input) || state.step > this.maxDecisionSteps || !last || last.ref !== active.ref || all[0]?.ref !== selection.ref || selection.key !== 'selection' || selection.returned?.status !== 'succeeded' || selection.reception.status !== 'accepted' || !isEqual(selection.returned.output, state.selection) || !isEqual(selection.reception.value, state.selection)) throw new Error('Conversation continuation differs from its accepted history selection');
    const decisions = facts.children.list(this.operationDefinitions.decision);
    const count = decisions.length;
    const expectedStep = last.key === 'selection' ? 0 : last.key === 'decision' || last.key === 'extraction' || !last.returned ? count - 1 : count;
    if (state.step !== expectedStep) throw new Error('Conversation continuation has an inconsistent decision budget');
    let expectedProgress: ExecutionProgress = {};
    let expectedCandidates: string[] = [];
    for (const child of all) {
      if (child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted') continue;
      if (child.key === 'decision') {
        facts.children.require(this.operationDefinitions.decision, child.ref);
        const accepted = decisionAcceptanceSchema.parse(child.reception.value);
        expectedProgress = accepted.progress;
        expectedCandidates = accepted.checkedCandidates;
      } else if (['preflight', 'generation', 'save'].includes(child.key ?? '')) expectedProgress = executionProgressSchema.parse(child.reception.value);
    }
    if (!isEqual(state.progress, expectedProgress) || !isEqual(state.checkedCandidates, expectedCandidates)) throw new Error('Conversation continuation differs from its latest accepted progress');
    if (last.key === 'decision' && !isEqual((last.input as { feedback?: unknown }).feedback, state.feedback)) throw new Error('Conversation continuation changed its decision feedback');
    const progress = state.progress;
    if (progress.answer) {
      const answerChild = all.find((child) => child.order === progress.responseOrder);
      if (!progress.receipt || !progress.response || progress.receipt.start !== progress.response.index || progress.response.message.role !== 'assistant' || progress.response.message.content !== progress.answer.content || !answerChild || answerChild.returned?.status !== 'succeeded' || answerChild.reception.status !== 'accepted') throw new Error('Conversation continuation has no accepted answer source');
      const source = answerChild.key === 'decision' ? decisionAcceptanceSchema.parse(answerChild.reception.value).progress : executionProgressSchema.parse(answerChild.reception.value);
      if (!isEqual(source.answer, progress.answer) || !isEqual(source.receipt, progress.receipt) || !isEqual(source.response, progress.response) || source.responseOrder !== progress.responseOrder) throw new Error('Conversation answer differs from its accepted entity receipt');
    } else if (progress.response || progress.receipt || progress.saved) throw new Error('Conversation progress has effects without an answer');
    if (progress.file) {
      const preflight = this.operationDefinitions.preflight;
      if (!preflight || !facts.children.list(preflight).some((child) => child.returned?.status === 'succeeded' && child.reception.status === 'accepted' && isEqual(child.returned.output, progress.file))) throw new Error('Conversation continuation has no accepted file preflight');
    }
    if (progress.saved) {
      const save = this.operationDefinitions.save;
      if (!save || !facts.children.list(save).some((child) => child.returned?.status === 'succeeded' && child.reception.status === 'accepted' && isEqual(child.returned.output, progress.saved))) throw new Error('Conversation continuation has no accepted file receipt');
    }
  }
}
