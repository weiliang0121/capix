import type { RuntimeDefinition } from '@capix-observer/runtime';
import { SelectHistory } from '../operations/history/select.js';
import { GenerateAnswer } from '../operations/answer/generate.js';
import { ExtractMemory } from '../operations/memory/extract.js';
import { ObserverExecutionDefinition } from './execution.js';

/** Business declarations contain no live environment or model provider. */
export class ObserverRuntimeDefinition implements RuntimeDefinition<ObserverExecutionDefinition> {
  readonly execution = new ObserverExecutionDefinition({ selection: new SelectHistory(), generation: new GenerateAnswer(), extraction: new ExtractMemory() });
}
