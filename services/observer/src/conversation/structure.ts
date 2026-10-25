import { ConversationScene } from './scene.js';
import { ConversationGroup, type ConversationCapabilities } from './conversation.js';
import { PrepareConversationContext } from './group/context/prepare.js';
import { MaintainConversationContent, type ContextMaintenanceConfiguration } from './group/context/maintain.js';
import { GenerateAnswer } from './group/answer/generate.js';
import { ExtractMemory } from './group/memory/extract.js';
import { ProcessDocument } from './group/document/process.js';
import { SaveResult } from './group/document/save.js';
import { DefaultConversationDecision } from './decision/default.js';
import type { ConversationDecisionFactory } from './decision/types.js';
import { CheckFileTask } from './group/preflight/check.js';

export interface ConversationStructureOptions {
  readonly files?: boolean;
  readonly decision?: ConversationDecisionFactory;
  readonly maxDecisionSteps?: number;
  readonly maintenance?: ContextMaintenanceConfiguration;
}

/** Construction references have no identity or lifetime beyond the structures they name. */
export interface ConversationStructure extends ConversationCapabilities {
  readonly scene: ConversationScene;
  readonly conversation: ConversationGroup;
}

/** Construct once, retaining the exact targets needed by resource scopes and call hooks. */
export function createConversationStructure(options: ConversationStructureOptions = {}): ConversationStructure {
  const files = Boolean(options.files);
  const preparation = new PrepareConversationContext(createMaintenance(options.maintenance));
  const maintenance = createMaintenance(options.maintenance);
  const generation = new GenerateAnswer({ files });
  const extraction = new ExtractMemory();
  const decision = options.decision ? options.decision.create() : new DefaultConversationDecision({ files });
  const preflight = files ? new CheckFileTask() : undefined;
  const document = files ? new ProcessDocument() : undefined;
  const save = files ? new SaveResult() : undefined;
  const capabilities: ConversationCapabilities = { preparation, generation, extraction, decision, maintenance, preflight, document, save };
  const conversation = new ConversationGroup(capabilities, { maxDecisionSteps: options.maxDecisionSteps });
  const scene = new ConversationScene(conversation, options);
  return { scene, conversation, ...capabilities };
}

function createMaintenance(configuration: ContextMaintenanceConfiguration | undefined): MaintainConversationContent | undefined {
  if (!configuration) return undefined;
  return new MaintainConversationContent(typeof configuration === 'function' ? configuration : configuration.create());
}
