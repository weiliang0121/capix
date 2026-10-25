import { bindResources, ResourceOffer, TranscriptResource, type ResourceRequirements, type NodeWork, type GroupWork, type SceneWork } from '@capix/server-runtime';

type Resources = { settings: { timeoutMs: number } };
const settings = new ResourceOffer({ name: 'settings', expose: (source: { timeout: number }) => Object.freeze({ timeoutMs: source.timeout }) });
const deps: ResourceRequirements<Resources> = { settings: settings.request() };
const bind = bindResources(deps, [settings.provide((parent: { timeout: number }) => parent)]);
const value: number = bind({ timeout: 1000 }).values.settings.timeoutMs;
void value;
// @ts-expect-error source must match the contract published by the resource
settings.provide(() => 'not settings');
// @ts-expect-error request result must match the capability's resource interface
const wrong: ResourceRequirements<Resources> = { settings: TranscriptResource.fixedRange.request() };
void wrong;
declare const work: NodeWork<string, string, Resources>;
// @ts-expect-error undeclared aliases are not exposed by this work
work.resources.history;
// @ts-expect-error bindings cannot replace a resource reference
work.resources.settings = { timeoutMs: 1 };

// @ts-expect-error parent operation is not a public resource path
work.operationContext;
declare const scene: SceneWork<unknown, unknown, Resources>;
declare const group: GroupWork<unknown, unknown, Resources>;
// @ts-expect-error construction metadata is not a business resource
scene.settings;
// @ts-expect-error raw collection references remain internal
scene.transcriptRange;
// @ts-expect-error ancestors are private lifecycle links
group.executionContext;

interface MutableSource {
  readonly current: number;
}
interface CapturedSource {
  readonly fixed: number;
}
const captured = new ResourceOffer<MutableSource, number, CapturedSource>({ name: 'captured', expose: (value: CapturedSource) => value.fixed, timing: 'binding', capture: (source) => ({ fixed: source.current }), describe: (value: CapturedSource) => value });
captured.provide(() => ({ current: 4 }));
// @ts-expect-error capture does not erase the source declaration
captured.provide(() => ({ fixed: 4 }));
