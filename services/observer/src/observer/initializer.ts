import { Initializer, BehaviorInitializer, type Runtime } from '@capix-observer/runtime';
import { isFunction } from 'es-toolkit/predicate';
import type { ModelProvider } from '../provider.js';
import { SelectHistory } from '../operations/history/select.js';
import { GenerateAnswer } from '../operations/answer/generate.js';
import { ExtractMemory } from '../operations/memory/extract.js';
import { ObserverExecution } from './execution.js';
import { ObserverResourceInitializer } from './resources.js';

export type ModelInitialization = ModelProvider | (() => ModelProvider);

/** Runtime-local assembly. E uses these declared members; actual call ownership stays in Invocation. */
export class ObserverInitializer {
  readonly resources: ObserverResourceInitializer;
  readonly selection: BehaviorInitializer<SelectHistory>;
  readonly generation: BehaviorInitializer<GenerateAnswer>;
  readonly extraction: BehaviorInitializer<ExtractMemory>;
  readonly execution: Initializer<ObserverExecution>;

  constructor(runtime: Runtime, model: ModelInitialization) {
    this.resources = new ObserverResourceInitializer(runtime.context, isFunction(model) ? model : () => model);
    this.selection = new BehaviorInitializer(SelectHistory.requires, () => new SelectHistory(runtime));
    this.generation = new BehaviorInitializer(GenerateAnswer.requires, () => new GenerateAnswer(runtime));
    this.extraction = new BehaviorInitializer(ExtractMemory.requires, () => new ExtractMemory(runtime));
    const operations = Object.freeze({ selection: this.selection, generation: this.generation, extraction: this.extraction });
    const bindings = Object.freeze({ execution: this.resources.execution, entry: this.resources.entry });
    this.execution = new Initializer(() => new ObserverExecution(runtime.executionInvocations, operations, bindings));
  }
}
