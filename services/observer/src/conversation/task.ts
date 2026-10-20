import { z } from 'zod';
import { invocationRecording } from '@capix/server-runtime/recording';
import { GroupDefinition, RuntimeError, reception, checkpointPoint, childReference, type GroupWork, type ResumeWork, type ChildContract, type ChildrenOf, type ChildCall, type ChildFact, type CheckpointFacts, type InvocationCheckpointPoint, type ReceptionDefinition } from '@capix/server-runtime';
import { isEqual } from 'es-toolkit';
import type { GenerationOutput, ConversationTask } from '@capix/protocol';
import { conversationTaskRequests, type ConversationTaskResources } from './resources.js';
import { prepareMemoryInput } from './group/memory/input.js';
import type { PrepareConversationContextDefinition, PreparedConversationContext } from './group/context/prepare.js';
import type { MaintainConversationContentDefinition } from './group/context/maintain.js';
import type { ActiveContentSnapshot } from './content/active.js';
import { describeActiveContent, describePreparedConversationContext } from './content/observation.js';
import type { ExtractMemoryDefinition } from './group/memory/extract.js';
import { type AcceptedConversationInput } from './accept.js';
import type { GenerateAnswerDefinition } from './group/answer/generate.js';
import { answerStream, type AnswerProgress, type AnswerGenerationEvent } from './group/answer/stream.js';
import type { ProcessDocumentDefinition } from './group/document/process.js';
import type { SaveResultDefinition } from './group/document/save.js';
import type { CheckFileTaskDefinition } from './group/preflight/check.js';
import { modelTextSchema } from './model/schema.js';
import type { ConversationDecisionDefinition } from './decision/types.js';
import { acceptConversationDecision, conversationCapability, reviseDecision, type ConversationCapability, type ConversationCapabilityCall } from './decision/capability.js';
import { checkpointCodec, decisionAcceptanceSchema, executionProgressSchema, acceptedCheckpointInput, conversationCheckpointOutput, executionWaitingState, executionDecisionState, executionCapabilityState, executionAcceptedState, type ExecutionProgress, type ExecutionContinuation, type ExecutionWaitingState, type ExecutionDecisionState, type ExecutionCapabilityState, type DecisionAcceptance } from './checkpoint.js';

export interface ConversationOperationDefinitions {
  readonly preparation: PrepareConversationContextDefinition;
  readonly maintenance?: MaintainConversationContentDefinition;
  readonly generation: GenerateAnswerDefinition;
  readonly extraction: ExtractMemoryDefinition;
  readonly decision: ConversationDecisionDefinition;
  readonly preflight?: CheckFileTaskDefinition;
  readonly document?: ProcessDocumentDefinition;
  readonly save?: SaveResultDefinition;
}

type Work = GroupWork<AcceptedConversationInput, GenerationOutput, ConversationTaskResources, ChildrenOf<'group'>, AnswerProgress> | ResumeWork<'group', AcceptedConversationInput, GenerationOutput, ConversationTaskResources, ChildrenOf<'group'>, AnswerProgress>;
type Facts = CheckpointFacts<AcceptedConversationInput>;
type Point = InvocationCheckpointPoint<AcceptedConversationInput, GenerationOutput, 'group', any, any, any, any, AnswerProgress>;
const emptyArguments = z.strictObject({});
const path = z.string().min(1).max(1024);
const output = z.strictObject({ path });
const fileArguments = z.strictObject({ task: z.union([z.strictObject({ sourcePath: path, output: output.optional() }), z.strictObject({ output })]), instruction: modelTextSchema });

/** E admits decisions and child deliveries. All evolving business state belongs to this call. */
export class ConversationTaskDefinition extends GroupDefinition<AcceptedConversationInput, GenerationOutput, ConversationTaskResources, Record<string, never>, AnswerProgress> {
  readonly name = 'conversationTask';
  readonly label = '本次对话任务';
  readonly output = { result: answerStream.result, delta: (value: unknown) => value as AnswerProgress };
  readonly observation = [
    invocationRecording<AcceptedConversationInput, GenerationOutput>({
      role: 'conversation-task',
      input: ({ message, fileTask }) => ({ ...message, ...(fileTask ? { fileTask } : {}) }),
      relationAccepted: (output, relation) => {
        if (relation.key === 'preparation') return describePreparedConversationContext(output as PreparedConversationContext);
        if (relation.key === 'maintenance') return describeActiveContent(output as ActiveContentSnapshot);
        return output;
      },
    }),
  ];
  readonly run;
  readonly members;
  readonly receptions: readonly ReceptionDefinition<ConversationDecisionDefinition, DecisionAcceptance>[];
  readonly decisionReception: ReceptionDefinition<ConversationDecisionDefinition, DecisionAcceptance>;
  readonly maxDecisionSteps: number;
  readonly checkpoint;
  readonly preparationWaiting;
  readonly preparationAccepted;
  readonly decisionWaiting;
  readonly decisionAccepted;
  readonly extractionWaiting;
  readonly completed;
  readonly maintenanceWaiting;
  readonly maintenanceCompleted;
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
    this.members = Object.freeze(Object.values(operationDefinitions).filter((definition) => definition !== undefined));
    const decisionValue = { check: (value: unknown) => decisionAcceptanceSchema.parse(value), ...checkpointCodec(decisionAcceptanceSchema) };
    this.decisionReception = reception(operationDefinitions.decision, decisionValue);
    this.receptions = [this.decisionReception];
    this.run = { requires: conversationTaskRequests, uses: this.members, execute: this.execute.bind(this) };
    const point = checkpointPoint<'group', AcceptedConversationInput, GenerationOutput, AnswerProgress>();
    this.preparationWaiting = point({
      name: 'preparationWaiting',
      state: checkpointCodec(z.strictObject({})),
      references: { active: childReference(operationDefinitions.preparation) },
      check: (_state, facts) => {
        const child = this.checkChild(facts, facts.references.active, 'preparation', operationDefinitions.preparation);
        if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input)) throw new Error('Preparation continuation changed the admitted input');
      },
      resume: { requires: this.run.requires, uses: this.members, execute: (work, _state, saved) => this.receivePreparation(work, work.children.resume(saved.active)) },
    });
    this.preparationAccepted = point({
      name: 'preparationAccepted',
      state: executionAcceptedState,
      references: { active: childReference(operationDefinitions.preparation) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        this.checkChild(facts, facts.references.active, 'preparation', operationDefinitions.preparation, 'accepted');
        if (facts.children.values().length !== 1) throw new Error('Preparation continuation contains later work');
      },
      resume: { requires: this.run.requires, uses: this.members, execute: (work, state) => this.advance(work, state) },
    });
    this.decisionWaiting = point({
      name: 'decisionWaiting',
      state: executionWaitingState,
      references: { active: childReference(operationDefinitions.decision) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        this.checkChild(facts, facts.references.active, 'decision', operationDefinitions.decision);
      },
      resume: { requires: this.run.requires, uses: this.members, execute: (work, state, saved) => this.receiveDecision(work, state, work.children.resume(saved.active)) },
    });
    this.decisionAccepted = point({
      name: 'decisionAccepted',
      state: executionDecisionState,
      references: { active: childReference(operationDefinitions.decision) },
      check: (state, facts) => {
        this.checkProgress(facts, state, facts.references.active);
        const child = this.checkChild(facts, facts.references.active, 'decision', operationDefinitions.decision, 'accepted');
        if (!isEqual(facts.children.accepted(child.ref, this.decisionReception), { choice: state.choice, progress: state.progress, checkedCandidates: state.checkedCandidates })) throw new Error('Decision continuation differs from its accepted proposal');
      },
      resume: { requires: this.run.requires, uses: this.members, execute: (work, state) => this.afterDecision(work, state) },
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
            const decided = facts.children.require(operationDefinitions.decision, decision.ref);
            if (!isEqual(facts.children.accepted(decided.ref, this.decisionReception).choice, { kind: 'invoke', capability: state.capability, arguments: state.arguments })) throw new Error('Capability continuation differs from the accepted decision');
          },
          resume: { requires: this.run.requires, uses: this.members, execute: (work, state, saved) => this.receiveCapability(work, state, work.children.resume(saved.active)) },
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
          resume: { requires: this.run.requires, uses: this.members, execute: (work, state) => this.advance(work, state) },
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
      resume: { requires: this.run.requires, uses: this.members, execute: (work, state, saved) => this.receiveExtraction(work, state, work.children.resume(saved.active)) },
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
      resume: { requires: this.run.requires, uses: this.members, execute: (work, state) => this.finishContent(work, state) },
    });
    const maintenance = operationDefinitions.maintenance;
    this.maintenanceWaiting = maintenance
      ? point({
          name: 'maintenanceWaiting',
          state: executionAcceptedState,
          references: { active: childReference(maintenance) },
          check: (state, facts) => {
            this.checkProgress(facts, state, facts.references.active);
            this.checkMaintenance(facts, state, facts.references.active);
          },
          resume: { requires: this.run.requires, uses: this.members, execute: (work, state, saved) => this.receiveMaintenance(work, state, work.children.resume(saved.active)) },
        })
      : undefined;
    this.maintenanceCompleted = maintenance
      ? point({
          name: 'maintenanceCompleted',
          state: executionAcceptedState,
          references: { active: childReference(maintenance) },
          check: (state, facts) => {
            this.checkProgress(facts, state, facts.references.active);
            this.checkMaintenance(facts, state, facts.references.active, 'accepted');
          },
          resume: { requires: {}, uses: [], execute: (_work, state) => state.progress.answer! },
        })
      : undefined;
    this.checkpoint = { key: 'observer.conversation.task', version: 6, input: acceptedCheckpointInput, output: conversationCheckpointOutput, points: [this.preparationWaiting, this.preparationAccepted, this.decisionWaiting, this.decisionAccepted, ...this.capabilityWaiting.values(), ...this.capabilityAccepted.values(), this.extractionWaiting, this.completed, ...(this.maintenanceWaiting ? [this.maintenanceWaiting] : []), ...(this.maintenanceCompleted ? [this.maintenanceCompleted] : [])] };
  }

  private async execute(work: Work): Promise<GenerationOutput> {
    const child = work.children.create(this.operationDefinitions.preparation, work.input, { key: 'preparation' });
    work.checkpoint?.save(this.preparationWaiting, {}, { active: child.ref });
    return this.receivePreparation(work, child);
  }

  private async receivePreparation(work: Work, child: ChildCall<PrepareConversationContextDefinition>): Promise<GenerationOutput> {
    await child.run();
    const prepared = await child.accept((delivered) => {
      work.resources.selectionUsage.add(delivered.context.selectedMessages);
      return delivered;
    });
    const state = { prepared, progress: {}, step: 0, checkedCandidates: [] };
    work.checkpoint?.save(this.preparationAccepted, state, { active: child.ref });
    return this.advance(work, state);
  }

  private async advance(work: Work, state: ExecutionContinuation): Promise<GenerationOutput> {
    state = { prepared: state.prepared, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates, ...(state.feedback ? { feedback: state.feedback } : {}) };
    if (state.step >= this.maxDecisionSteps) throw new RuntimeError('DECISION_LIMIT', '本轮决策未能在限定步数内完成，已落实的消息和文件保留。');
    const { message, fileTask } = work.input;
    const progress = state.progress;
    const capabilities = this.capabilities(work, state.prepared);
    const child = work.children.create(
      this.operationDefinitions.decision,
      {
        request: { message, history: structuredClone(state.prepared.context.selectedMessages), memories: structuredClone(state.prepared.material.memories), ...(fileTask ? { fileTask: structuredClone(fileTask) } : {}) },
        ...structuredClone({ progress: { ...(progress.file ? { file: progress.file } : {}), ...(progress.answer ? { answer: progress.answer } : {}), ...(progress.saved ? { saved: progress.saved } : {}) }, ...(progress.latest ? { latest: progress.latest } : {}), available: [...capabilities.values()].filter((entry) => entry.available(progress)).map((entry) => entry.offer), ...(state.feedback ? { feedback: state.feedback } : {}) }),
      },
      { key: 'decision' },
    );
    const waiting = { ...state };
    if (this.operationDefinitions.decision.checkpoint) work.checkpoint?.save(this.decisionWaiting, waiting, { active: child.ref });
    return this.receiveDecision(work, waiting, child);
  }

  private async receiveDecision(work: Work, state: ExecutionWaitingState, child: ChildCall<ConversationDecisionDefinition>): Promise<GenerationOutput> {
    await child.run();
    const capabilities = this.capabilities(work, state.prepared);
    const accepted = await child.accept(this.decisionReception, (delivered) => {
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
    const next: ExecutionDecisionState = { ...state, ...accepted };
    work.checkpoint?.save(this.decisionAccepted, next, { active: child.ref });
    return this.afterDecision(work, next);
  }

  private async afterDecision(work: Work, state: ExecutionDecisionState): Promise<GenerationOutput> {
    const choice = state.choice;
    if (choice.kind === 'revise') return this.advance(work, { ...state, step: state.step + 1, feedback: choice.feedback });
    if (choice.kind === 'finish') {
      if (choice.conclusion.kind !== 'settled') return this.finishContent(work, state);
      const child = work.children.create(this.operationDefinitions.extraction, prepareMemoryInput({ index: work.input.messageIndex, message: work.input.message }, state.progress.response!, state.prepared.context.selectedMessages, state.prepared.material.memories, { saved: state.progress.saved }), { key: 'extraction' });
      const waiting = { prepared: state.prepared, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates };
      work.checkpoint?.save(this.extractionWaiting, waiting, { active: child.ref });
      return this.receiveExtraction(work, waiting, child);
    }
    const capability = this.capabilities(work, state.prepared).get(choice.capability)!;
    const child = capability.create(choice.arguments, state.progress);
    const waiting: ExecutionCapabilityState = { prepared: state.prepared, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates, capability: choice.capability, arguments: choice.arguments };
    work.checkpoint?.save(this.capabilityWaiting.get(choice.capability)!, waiting, { active: child.ref });
    return this.receiveCapability(work, waiting, child, capability);
  }

  private async receiveCapability(work: Work, state: ExecutionCapabilityState, child: ConversationCapabilityCall, capability = this.capabilities(work, state.prepared).get(state.capability)!): Promise<GenerationOutput> {
    await child.run();
    const progress = await capability.accept(child, state.progress);
    const next = { prepared: state.prepared, progress, step: state.step + 1, checkedCandidates: state.checkedCandidates };
    work.checkpoint?.save(this.capabilityAccepted.get(state.capability)!, next, { active: child.ref });
    return this.advance(work, next);
  }

  private async receiveExtraction(work: Work, state: ExecutionWaitingState, child: ChildCall<ExtractMemoryDefinition>): Promise<GenerationOutput> {
    await child.run();
    await child.accept((delivered) => delivered);
    work.checkpoint?.save(this.completed, state, { active: child.ref });
    return this.finishContent(work, state);
  }

  private async finishContent(work: Work, state: ExecutionContinuation): Promise<GenerationOutput> {
    const maintenance = this.operationDefinitions.maintenance;
    if (!maintenance) return state.progress.answer!;
    const settled = { prepared: state.prepared, progress: state.progress, step: state.step, checkedCandidates: state.checkedCandidates };
    const child = work.children.create(maintenance, { phase: 'after-content' }, { key: 'maintenance' });
    work.checkpoint?.save(this.maintenanceWaiting!, settled, { active: child.ref });
    return this.receiveMaintenance(work, settled, child);
  }

  private async receiveMaintenance(work: Work, state: ExecutionContinuation, child: ChildCall<MaintainConversationContentDefinition>): Promise<GenerationOutput> {
    await child.run();
    await child.accept();
    work.checkpoint?.save(this.maintenanceCompleted!, state, { active: child.ref });
    return state.progress.answer!;
  }

  private checkMaintenance(facts: Facts, state: ExecutionContinuation, active: ChildFact, status: 'waiting' | 'accepted' = 'waiting'): void {
    const maintenance = this.operationDefinitions.maintenance;
    if (!maintenance || !state.progress.answer) throw new Error('Maintenance continuation requires its accepted answer');
    const child = this.checkChild(facts, active, 'maintenance', maintenance, status);
    if (!isEqual(child.input, { phase: 'after-content' })) throw new Error('Maintenance continuation changed its boundary');
    const previous = facts.children.values().at(-2);
    if (!previous || previous.reception.status !== 'accepted') throw new Error('Maintenance must follow accepted content work');
    if (previous.key === 'extraction') facts.children.require(this.operationDefinitions.extraction, previous.ref);
    else {
      const decision = facts.children.require(this.operationDefinitions.decision, previous.ref);
      const choice = decisionAcceptanceSchema.parse(decision.reception.status === 'accepted' ? decision.reception.value : undefined).choice;
      if (choice.kind !== 'finish' || choice.conclusion.kind === 'settled') throw new Error('Maintenance cannot skip memory extraction');
    }
  }

  private appendAnswer(work: Work, answer: GenerationOutput, childOrder: number): Pick<ExecutionProgress, 'answer' | 'response' | 'receipt' | 'responseOrder'> {
    if (work.checkpoint) {
      const receipt = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: answer.content }] });
      return { answer, response: { index: receipt.start, message: { role: 'assistant', content: answer.content } }, receipt: { ...receipt, count: 1 }, responseOrder: childOrder };
    }
    return { answer, response: work.resources.messages.append([{ role: 'assistant', content: answer.content }])[0]! };
  }

  private capabilities(work: Work, prepared: PreparedConversationContext): ReadonlyMap<string, ConversationCapability<ExecutionProgress>> {
    const resources = work.resources;
    const definitions = this.operationDefinitions;
    const input = (state: ExecutionProgress) => ({ context: prepared.context, memories: prepared.material.memories, ...(state.file ? { task: { fileTask: state.file.task, instruction: state.file.instruction } } : {}) });
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

  private checkChild<Definition extends ChildContract>(facts: Facts, selected: ChildFact, key: string, definition: Definition, status: 'waiting' | 'accepted' = 'waiting') {
    const child = facts.children.require(definition, selected.ref);
    if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input) || facts.children.values().at(-1)?.ref !== child.ref || child.key !== key) throw new Error('Conversation continuation must identify its exact declared child');
    if (status === 'waiting' ? child.returned !== undefined : child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted') throw new Error('Conversation continuation has the wrong child reception stage');
    return child;
  }

  private checkSettledDecision(facts: Facts): void {
    const child = facts.children.values().at(-2);
    if (!child) throw new Error('Memory continuation has no settled decision');
    const decided = facts.children.require(this.operationDefinitions.decision, child.ref);
    if (child.key !== 'decision' || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isEqual(facts.children.accepted(decided.ref, this.decisionReception).choice, { kind: 'finish', conclusion: { kind: 'settled' } })) throw new Error('Memory continuation requires the accepted settled decision');
  }

  private checkCapabilityInput(facts: Facts, state: ExecutionCapabilityState, actual: unknown): void {
    const progress = state.progress;
    const generation = { context: state.prepared.context, memories: state.prepared.material.memories, ...(progress.file ? { task: { fileTask: progress.file.task, instruction: progress.file.instruction } } : {}) };
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
    const selection = facts.children.requireUnique(this.operationDefinitions.preparation, { parentRound: 1 });
    const last = all.at(-1);
    if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input) || state.step > this.maxDecisionSteps || !last || last.ref !== active.ref || all[0]?.ref !== selection.ref || selection.key !== 'preparation' || selection.returned?.status !== 'succeeded' || selection.reception.status !== 'accepted' || !isEqual(selection.returned.output, state.prepared) || !isEqual(selection.reception.value, state.prepared)) throw new Error('Conversation continuation differs from its accepted fixed material');
    const decisions = facts.children.list(this.operationDefinitions.decision);
    const count = decisions.length;
    const expectedStep = last.key === 'preparation' ? 0 : last.key === 'decision' || last.key === 'extraction' || last.key === 'maintenance' || !last.returned ? count - 1 : count;
    if (state.step !== expectedStep) throw new Error('Conversation continuation has an inconsistent decision budget');
    let expectedProgress: ExecutionProgress = {};
    let expectedCandidates: string[] = [];
    for (const child of all) {
      if (child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted') continue;
      if (child.key === 'decision') {
        const decided = facts.children.require(this.operationDefinitions.decision, child.ref);
        const accepted = facts.children.accepted(decided.ref, this.decisionReception);
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
      const source = answerChild.key === 'decision' ? facts.children.accepted(facts.children.require(this.operationDefinitions.decision, answerChild.ref).ref, this.decisionReception).progress : executionProgressSchema.parse(answerChild.reception.value);
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
