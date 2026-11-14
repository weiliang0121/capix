import type { CallableInput, CallableOutput, Stable } from '@weiliang0121/capix-contracts';
import type { ChildCallable } from '@weiliang0121/capix-structure';
import type { ModelRequest, ToolResult } from '@weiliang0121/capix-model-provider';
import type { z } from 'zod';
import type { ToolByteBudgets } from './budget.js';

/** Member policy, not another callable or a registration lifetime. */
export interface ToolMember<Member extends ChildCallable> {
  readonly node: Member;
  readonly description: string;
  readonly input: z.ZodType<CallableInput<NoInfer<Member>>>;
  /** Enforce this inside the member before its own checkpoint; Tool checks the return too. */
  readonly maxOutputBytes?: number;
  readonly result: {
    /** Pure mapping: recovery may recompute it before the parent acceptance is saved. */
    readonly succeeded: (value: Stable<CallableOutput<NoInfer<Member>>>) => ToolResult | Promise<ToolResult>;
    readonly failed?: (failure: unknown) => ToolResult | Promise<ToolResult>;
  };
}

export type ToolMembers<Definitions extends Readonly<Record<string, ChildCallable>>> = { readonly [Name in keyof Definitions]: ToolMember<Definitions[Name]> };
export type ToolBaseRequest = Omit<ModelRequest, 'tools' | 'exchanges'>;
export interface ToolInput {
  readonly request: ToolBaseRequest;
}
export interface ToolConfiguration<Definitions extends Readonly<Record<string, ChildCallable>>> {
  readonly tools: ToolMembers<Definitions>;
  /** Versions refinements, result mappings and the author's execution policy. */
  readonly policyVersion: string;
  readonly checkpoint?: boolean;
  /** Per-invocation model call fuse. Defaults to 1000; must be a positive safe integer. */
  readonly maxModelCalls?: number;
  readonly waitMs?: number;
  readonly budgets?: Partial<ToolByteBudgets>;
}
