import type { ModelSettings } from '@capix/protocol';
import type { GroupDefinition } from '@capix/server-runtime';
import type { ActiveContentSelection, ActiveContentSnapshot } from '../../content/active.js';
import type { AnswerMessageContext } from '../../node/context/assemble.js';

export interface PreparedConversationContext {
  readonly material: ActiveContentSnapshot;
  readonly context: AnswerMessageContext;
  readonly selection: { readonly historyIndexes: readonly number[] };
}

export interface ContextMaintenanceRequest {
  readonly phase: 'before-request' | 'after-content';
}

export interface ContextMaintenanceInput extends ContextMaintenanceRequest {
  readonly material: ActiveContentSnapshot;
  readonly settings: Readonly<ModelSettings>;
}

export type ContextMaintenanceDecision = ActiveContentSelection;
export type ContextMaintenanceOperation = GroupDefinition<ContextMaintenanceInput, ContextMaintenanceDecision, any, any, any>;
export type ContextMaintenancePolicy = ((input: ContextMaintenanceInput) => ContextMaintenanceDecision | Promise<ContextMaintenanceDecision>) | ContextMaintenanceOperation;
