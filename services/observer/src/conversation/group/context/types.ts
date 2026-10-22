import type { ModelSettings } from '@capix/protocol';
import type { Group } from '@capix/server-runtime';
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
export type ContextMaintenanceOperation = Group<ContextMaintenanceInput, ContextMaintenanceDecision, any, any, any>;
export type ContextMaintenanceFunction = (input: ContextMaintenanceInput) => ContextMaintenanceDecision | Promise<ContextMaintenanceDecision>;
/** A single maintenance boundary can consume a concrete, unowned policy structure. */
export type ContextMaintenancePolicy = ContextMaintenanceFunction | ContextMaintenanceOperation;
/** Host configuration is reusable; each boundary gets its own policy structure. */
export type ContextMaintenanceConfiguration = ContextMaintenanceFunction | { readonly create: () => ContextMaintenanceOperation };
