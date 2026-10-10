import { bindResources, ResourceOffer, TranscriptResource, type ResourceRequirements, type AttemptContext } from '@capix/server-runtime';

type Resources = { settings: { timeoutMs: number } };
const settings = new ResourceOffer('settings', (source: { timeout: number }) => Object.freeze({ timeoutMs: source.timeout }));
const requires: ResourceRequirements<Resources> = { settings: settings.request() };
const bind = bindResources(requires, [settings.provide((parent: { timeout: number }) => parent)]);
const value: number = bind({ timeout: 1000 }).values.settings.timeoutMs;
void value;
// @ts-expect-error source must match the contract published by the resource
settings.provide(() => 'not settings');
// @ts-expect-error request result must match the capability's resource interface
const wrong: ResourceRequirements<Resources> = { settings: TranscriptResource.fixedRange.request() };
void wrong;
declare const context: AttemptContext<string, string, Resources>;
// @ts-expect-error undeclared aliases are not exposed by this context
context.resources.values.history;
// @ts-expect-error bindings cannot replace a resource reference
context.resources.values.settings = { timeoutMs: 1 };

// @ts-expect-error parent operation is not a public resource path
context.operationContext;
import type { ExecutionContext, OperationContext } from '@capix/server-runtime';
declare const execution: ExecutionContext;
declare const operation: OperationContext;
// @ts-expect-error construction metadata is not a business resource
execution.settings;
// @ts-expect-error raw collection references remain internal
execution.transcriptRange;
// @ts-expect-error ancestors are private lifecycle links
operation.executionContext;

interface MutableSource {
  readonly current: number;
}
interface CapturedSource {
  readonly fixed: number;
}
const captured = new ResourceOffer<MutableSource, number, CapturedSource>('captured', (value: CapturedSource) => value.fixed, 'binding', { capture: (source) => ({ fixed: source.current }), describe: (value: CapturedSource) => value });
captured.provide(() => ({ current: 4 }));
// @ts-expect-error capture does not erase the source declaration
captured.provide(() => ({ fixed: 4 }));
