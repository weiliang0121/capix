import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { AttemptDefinition, checkpointPoint, type AttemptWork, type InvocationCheckpointDefinition } from '@capix/server-runtime';
import { interactionRefCodec, interactionResultCodec, modelRequestCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../operations/checkpoint.js';
import { checkCapacity } from '../../model/capacity.js';
import type { ModelRequest, ModelOutput, Purpose } from '../../model/types.js';
import type { ModelInteractionRef, ModelInteractionResult } from '../../model/interactions.js';

/** Initiate one exchange and wait locally; pending is an explicit delivery to its parent. */
export class InvokeModelDefinition extends AttemptDefinition<ModelRequest, ModelInteractionResult, ModelCallResources, Record<string, never>, ModelInteractionRef> {
  readonly output = {
    result: (value: unknown) => value as ModelInteractionResult,
    delta: (value: unknown): ModelInteractionRef => {
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new TypeError('Model interaction reference required');
      return value as ModelInteractionRef;
    },
  };
  readonly observation;
  readonly checkpoint: InvocationCheckpointDefinition<ModelRequest, ModelInteractionResult, 'attempt', ModelInteractionRef>;
  static readonly requires = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() });
  readonly run = { requires: InvokeModelDefinition.requires, execute: this.execute.bind(this) };
  readonly name = 'invokeModel';
  readonly label = '发起模型调用';
  readonly source = 'services/observer/src/conversation/attempt/model/invoke.ts · InvokeModelDefinition';
  readonly callee = 'provider';
  private readonly resultPoint = checkpointPoint<'attempt', ModelRequest, ModelInteractionResult, ModelInteractionRef>()({ name: 'result', state: interactionResultCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });
  private readonly interactionStartedPoint = checkpointPoint<'attempt', ModelRequest, ModelInteractionResult, ModelInteractionRef>()({
    name: 'interactionStarted',
    state: interactionRefCodec,
    references: {},
    check: (_state, facts) => checkLeafResult(facts),
    resume: {
      requires: { modelReader: ModelResource.read.request() },
      execute: async (work, interaction) => {
        const output = await work.resources.modelReader.result(interaction, { signal: work.signal, expected: { request: work.input, purpose: this.purpose } });
        const result: ModelInteractionResult = { kind: 'received', interaction, output };
        work.checkpoint?.save(this.resultPoint, result, {});
        return result;
      },
    },
  });

  constructor(
    private readonly purpose: Purpose,
    description: InvocationRecordDescription<ModelRequest, ModelOutput> = {},
  ) {
    super();
    this.checkpoint = { key: `observer.invoke-model.${purpose}`, version: 1, input: modelRequestCodec, output: interactionResultCodec, points: [this.interactionStartedPoint, this.resultPoint] };
    this.observation = [invocationRecording<ModelRequest, ModelInteractionResult>({ input: description.input, output: (result) => (result.kind === 'received' ? { ...result, output: description.output ? description.output(result.output) : result.output } : result) })];
  }

  private async execute(work: AttemptWork<ModelRequest, ModelInteractionResult, ModelCallResources, ModelInteractionRef>): Promise<ModelInteractionResult> {
    const { timeoutMs, settings, modelCreator, modelReader } = work.resources;
    checkCapacity(work.input, settings);
    const interaction = modelCreator.start(work.input, this.purpose, { timeoutMs });
    work.checkpoint?.save(this.interactionStartedPoint, interaction, {});
    work.output.emit(interaction);
    const result = await modelReader.wait(interaction, { signal: work.signal, waitMs: Math.max(1, Math.floor(timeoutMs / 2)) });
    work.checkpoint?.save(this.resultPoint, result, {});
    return result;
  }
}
