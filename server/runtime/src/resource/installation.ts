import { randomUUID } from 'node:crypto';
import type { AnyCallable, ResolvedCallable } from '../binding/declarations.js';
import type { Interactions } from '../interaction/interactions.js';
import { Initializer } from '../initializer.js';
import { resourceRequests, checkResourceProviders } from './bindings.js';
import type { ResourceProvider, ResourceValue } from './offer.js';
import type { ResourcePlan, ResourceCaptureScope } from './resources.js';
import { ResourceSupply } from './supply.js';

interface InstalledScope<Options> {
  readonly resolved: ResolvedCallable;
  readonly fixed: readonly ResourceProvider<unknown>[];
  readonly local: readonly ResourceProvider<unknown>[];
  readonly capture?: ResourceCaptureScope<Options>['capture'];
}

/** Fixed supply routes. Each open creates captures, and Invocation creates the access window. */
export class ResourceInstallation<Options> {
  private readonly scopes = new Map<AnyCallable, InstalledScope<Options>>();

  constructor(root: ResolvedCallable, plan: ResourcePlan<Options>, interactions?: Interactions) {
    const visit = (resolved: ResolvedCallable, inherited: readonly ResourceProvider<unknown>[]): void => {
      const scope = plan.scopes.find((entry) => entry.structure === resolved.definition);
      const requested = resourceRequests(resolved.supply);
      const needed = new Set(requested.map((request) => request.offer));
      const local = (scope?.registrations ?? []).filter((entry) => needed.has(entry.offer)).map((entry) => entry.bind(interactions));
      const localOffers = new Set(local.map((entry) => entry.offer));
      const fixed = resolved === root ? plan.registrations.filter((entry) => needed.has(entry.offer) && !localOffers.has(entry.offer)).map((entry) => entry.bind(interactions)) : [];
      const available = [...(resolved === root ? fixed : inherited).filter((entry) => !localOffers.has(entry.offer)), ...local];
      checkResourceProviders(requested, available);
      this.scopes.set(resolved.definition, Object.freeze({ resolved, fixed, local, capture: local.length ? scope?.capture : undefined }));
      for (const member of resolved.members) visit(member, available);
    };
    visit(root, []);
  }

  open(structure: AnyCallable, input: unknown, options: Options, inherited?: ResourceSupply): ResourceSupply {
    const scope = this.scopes.get(structure);
    if (!scope) throw new Error('Callable resource scope is not installed');
    const base = inherited ?? captureSupply(scope.fixed, undefined);
    const snapshot = scope.capture?.(input, options);
    return base.overlay(captureSupply(scope.local, snapshot)).select(scope.resolved.supply);
  }
}

function captureSupply(providers: readonly ResourceProvider<unknown>[], source: unknown): ResourceSupply {
  const entries: ResourceValue[] = providers.map((provider) => {
    const captured = new Initializer(() => provider.resolve(source));
    if (provider.timing === 'binding') captured.get();
    return Object.freeze({ offer: provider.offer, supplyId: randomUUID(), timing: provider.timing, capture: () => captured.get(), expose: provider.expose, describe: provider.describe, get: () => captured.get() });
  });
  return new ResourceSupply(entries);
}
