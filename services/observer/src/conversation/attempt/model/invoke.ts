import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { AttemptDefinition, type InvocationWorkView, type InvocationCheckpointDefinition, type AttemptContextView } from '@capix/server-runtime';
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
  readonly checkpoint: InvocationCheckpointDefinition<ModelRequest, ModelInteractionResult, AttemptContextView<ModelRequest, ModelInteractionResult, ModelCallResources>, ModelInteractionRef>;
  static readonly requires = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() });
  readonly run = { requires: InvokeModelDefinition.requires, execute: this.execute.bind(this) };
  readonly name = 'invokeModel';
  readonly label = '发起模型调用';
  readonly source = 'services/observer/src/conversation/attempt/model/invoke.ts · InvokeModelDefinition';
  readonly callee = 'provider';

  constructor(
    private readonly purpose: Purpose,
    description: InvocationRecordDescription<ModelRequest, ModelOutput> = {},
  ) {
    super();
    this.checkpoint = {
      key: `observer.invoke-model.${purpose}`,
      version: 1,
      input: modelRequestCodec,
      output: interactionResultCodec,
      points: {
        interactionStarted: {
          state: interactionRefCodec,
          check: checkLeafResult,
          resume: {
            requires: { modelReader: ModelResource.read.request() },
            uses: [],
            execute: async (context, invocation, _children, interaction: ModelInteractionRef) => {
              const output = await context.resources.values.modelReader.result(interaction, { signal: context.signal, expected: { request: context.currentInput, purpose: this.purpose } });
              const result: ModelInteractionResult = { kind: 'received', interaction, output };
              invocation.checkpoint?.save('result', result);
              return result;
            },
          },
        },
        result: { state: interactionResultCodec, check: checkLeafResult, resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, result: ModelInteractionResult) => result } },
      },
    };
    this.observation = [invocationRecording<ModelRequest, ModelInteractionResult>({ input: description.input, output: (result) => (result.kind === 'received' ? { ...result, output: description.output ? description.output(result.output) : result.output } : result) })];
  }

  private async execute(context: AttemptContextView<ModelRequest, ModelInteractionResult, ModelCallResources>, invocation: InvocationWorkView<ModelRequest, ModelInteractionResult, AttemptContextView<ModelRequest, ModelInteractionResult, ModelCallResources>, ModelInteractionRef>): Promise<ModelInteractionResult> {
    const { timeoutMs, settings, modelCreator, modelReader } = context.resources.values;
    checkCapacity(context.currentInput, settings);
    const interaction = modelCreator.start(context.currentInput, this.purpose, { signal: context.signal, timeoutMs });
    invocation.checkpoint?.save('interactionStarted', interaction);
    invocation.output.emit(interaction);
    const result = await modelReader.wait(interaction, { signal: context.signal, waitMs: Math.max(1, Math.floor(timeoutMs / 2)) });
    invocation.checkpoint?.save('result', result);
    return result;
  }
}
