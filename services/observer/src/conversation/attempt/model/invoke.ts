import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { AttemptDefinition, type InvocationWorkView, type AttemptContextView } from '@capix/server-runtime';
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
    this.observation = [invocationRecording<ModelRequest, ModelInteractionResult>({ input: description.input, output: (result) => (result.kind === 'received' ? { ...result, output: description.output ? description.output(result.output) : result.output } : result) })];
  }

  private execute(context: AttemptContextView<ModelRequest, ModelInteractionResult, ModelCallResources>, invocation: InvocationWorkView<ModelRequest, ModelInteractionResult, AttemptContextView<ModelRequest, ModelInteractionResult, ModelCallResources>, ModelInteractionRef>): Promise<ModelInteractionResult> {
    const { timeoutMs, settings, modelCreator, modelReader } = context.resources.values;
    checkCapacity(context.currentInput, settings);
    const interaction = modelCreator.start(context.currentInput, this.purpose, { signal: context.signal, timeoutMs });
    invocation.output.emit(interaction);
    return modelReader.wait(interaction, { signal: context.signal, waitMs: Math.max(1, Math.floor(timeoutMs / 2)) });
  }
}
