import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { Node, checkpointPoint, type NodeWork } from '@capix/structure';
import { interactionRefCodec, interactionResultCodec, modelRequestCodec } from '../../model/checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import { checkCapacity } from '../../model/capacity.js';
import type { ModelRequest, Purpose } from '../../model/types.js';
import type { ModelInteractionRef, ModelInteractionResult } from '../../model/interactions.js';

/** Initiate one exchange and wait locally; pending is an explicit delivery to its parent. */
export class InvokeModel extends Node<ModelRequest, ModelInteractionResult, ModelCallResources, ModelInteractionRef> {
  static readonly deps = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() });

  private readonly resultPoint;
  private readonly interactionStartedPoint;

  constructor(private readonly purpose: Purpose) {
    super();

    this.resultPoint = checkpointPoint<'node', ModelRequest, ModelInteractionResult, ModelInteractionRef>()({ name: 'result', state: interactionResultCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { run: (_work, result) => result } });
    this.interactionStartedPoint = checkpointPoint<'node', ModelRequest, ModelInteractionResult, ModelInteractionRef>()({
      name: 'interactionStarted',
      state: interactionRefCodec,
      references: {},
      check: (_state, facts) => checkLeafResult(facts),
      resume: {
        deps: { modelReader: ModelResource.read.request() },
        run: async (work, interaction) => {
          const output = await work.resources.modelReader.result(interaction, { expected: { request: work.input, purpose: this.purpose } });
          const result: ModelInteractionResult = { kind: 'received', interaction, output };
          work.checkpoint?.({ point: this.resultPoint, state: result, refs: {} });
          return result;
        },
      },
    });

    this.output = {
      result: (value: unknown) => value as ModelInteractionResult,
      delta: (value: unknown): ModelInteractionRef => {
        if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new TypeError('Model interaction reference required');
        return value as ModelInteractionRef;
      },
    };
    this.checkpoint = { key: `observer.invoke-model.${purpose}`, version: 1, input: modelRequestCodec, output: interactionResultCodec, points: [this.interactionStartedPoint, this.resultPoint] };
    this.deps = InvokeModel.deps;
    this.run = this.execute.bind(this);
    this.name = 'invokeModel';
    this.label = '发起模型调用';
    this.source = 'services/observer/src/conversation/node/model/invoke.ts · InvokeModel';
  }

  private async execute(work: NodeWork<ModelRequest, ModelInteractionResult, ModelCallResources, ModelInteractionRef>): Promise<ModelInteractionResult> {
    const { timeoutMs, settings, modelCreator, modelReader } = work.resources;
    checkCapacity(work.input, settings);
    const interaction = modelCreator.start(work.input, this.purpose, { timeoutMs });
    work.checkpoint?.({ point: this.interactionStartedPoint, state: interaction, refs: {} });
    work.output.emit(interaction);
    const result = await modelReader.wait(interaction, { waitMs: Math.max(1, Math.floor(timeoutMs / 2)) });
    work.checkpoint?.({ point: this.resultPoint, state: result, refs: {} });
    return result;
  }
}
