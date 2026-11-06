import { isDeepStrictEqual, types } from 'node:util';
import { z } from 'zod';
import type { CallableInput, CallableOutput } from '@capix/contracts';
import type { ChildCallable } from '@capix/structure';
import type { ToolResult } from '@capix/model-provider';

const toolRegistration = Symbol('ToolRegistration');

export interface ToolRegistration<Definition extends ChildCallable = ChildCallable> {
  readonly [toolRegistration]: true;
  readonly node: Definition;
  readonly description: string;
  readonly input: z.ZodType<CallableInput<Definition>>;
  /** The tool itself must enforce this before its CP; the loop also checks returned values. */
  readonly maxOutputBytes?: number;
  readonly result: {
    readonly succeeded: (value: CallableOutput<Definition>) => ToolResult | Promise<ToolResult>;
    readonly failed?: (failure: unknown) => ToolResult | Promise<ToolResult>;
  };
}
export type ToolRegistrations = Readonly<Record<string, ToolRegistration>>;

/** Pure input/result policies. Their behavior belongs to the explicit loop policyVersion. */
export function tool<Definition extends ChildCallable>(
  node: Definition,
  configuration: {
    readonly description: string;
    readonly input: z.ZodType<CallableInput<NoInfer<Definition>>>;
    readonly maxOutputBytes?: number;
    readonly result: {
      readonly succeeded: (value: CallableOutput<NoInfer<Definition>>) => ToolResult | Promise<ToolResult>;
      readonly failed?: (failure: unknown) => ToolResult | Promise<ToolResult>;
    };
  },
): ToolRegistration<Definition> {
  if (!node || !['node', 'group'].includes(node.kind)) throw new TypeError('A tool must be a Node or Group');
  if (typeof configuration.description !== 'string' || !configuration.description.trim() || typeof configuration.input?.parse !== 'function' || typeof configuration.result?.succeeded !== 'function' || (configuration.result.failed !== undefined && typeof configuration.result.failed !== 'function')) throw new TypeError('Tool description, input and result policies are required');
  if (configuration.maxOutputBytes !== undefined && (!Number.isSafeInteger(configuration.maxOutputBytes) || configuration.maxOutputBytes < 1 || configuration.maxOutputBytes > 8 * 1024 * 1024)) throw new RangeError('Invalid tool output byte limit');
  const registration: ToolRegistration<Definition> = { [toolRegistration]: true, node, description: configuration.description, input: configuration.input, ...(configuration.maxOutputBytes === undefined ? {} : { maxOutputBytes: configuration.maxOutputBytes }), result: Object.freeze({ succeeded: configuration.result.succeeded, ...(configuration.result.failed ? { failed: configuration.result.failed } : {}) }) };
  return Object.freeze(registration);
}

export interface ToolEntry {
  readonly name: string;
  readonly position: number;
  readonly registration: ToolRegistration;
}
export function toolEntries(registrations: ToolRegistrations, checkpoint: boolean): readonly ToolEntry[] {
  if (!registrations || typeof registrations !== 'object' || Array.isArray(registrations) || types.isProxy(registrations) || Object.getOwnPropertySymbols(registrations).length) throw new TypeError('Tools must be a named registration object');
  const seen = new Set<ChildCallable>();
  const entries: ToolEntry[] = [];
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(registrations))) {
    if (!('value' in descriptor) || !descriptor.enumerable || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name) || ['models', 'completion', '__proto__', 'constructor', 'prototype'].includes(name)) throw new TypeError('Invalid tool registration name or property');
    const value: ToolRegistration = descriptor.value;
    if (!value || value[toolRegistration] !== true) throw new TypeError('Create tool registrations through tool(node, configuration)');
    const registration = tool(value.node, value);
    if (seen.has(registration.node)) throw new TypeError('Tool members must have distinct structure identities');
    if (checkpoint && !registration.node.checkpoint) throw new TypeError('Recoverable ToolLoop requires checkpoint contracts on its tool members');
    seen.add(registration.node);
    entries.push(Object.freeze({ name, position: entries.length + 1, registration }));
  }
  if (!entries.length || entries.length > 32) throw new RangeError('ToolLoop requires between 1 and 32 tools');
  return Object.freeze(entries);
}

/** A schema may validate, but cannot silently substitute different model arguments. */
export function parseToolInput(registration: ToolRegistration, input: unknown): unknown {
  const parsed: unknown = registration.input.parse(input);
  if (!isDeepStrictEqual(parsed, input)) throw new TypeError('Tool input policy must preserve the fixed model arguments');
  return parsed;
}
