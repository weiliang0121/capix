import { InvocationResources, type InvocationFact, type InvocationIdentity, type InvocationDescription, type InvocationObserver, InvocationObservation, ObserverSession, publishSessions } from '@capix/invocation';
import type { ObservationDeclaration, ObservationDeclarationScope } from '../definition/observation.js';
import { ResourceBinding, resourceRequests, type ResourceRequirements } from '@capix/resources';
import type { DriverFact, DriverObserver } from '../observation/driver.js';
import type { EventConsumer } from '@capix/changes';

/** A fixed host selection keeps its owner even when the declaration needs no resources. */
export interface InvocationObservationDeclaration extends ObservationDeclaration<InvocationFact> {
  readonly installation?: ObservationInstallation;
}

export interface InvocationObservationSetup {
  readonly identity: InvocationIdentity;
  readonly description?: InvocationDescription;
  readonly declarations?: readonly InvocationObservationDeclaration[];
  readonly resources: InvocationResources;
}

export interface ObservationInstallation {
  /** Host-selected consumers are fixed at build, independently of business configuration. */
  declarations?(structure: ObservationDeclarationScope): readonly ObservationDeclaration<InvocationFact>[];
  check?(definition: ObservationDeclarationScope, parent?: ObservationDeclarationScope): void;
  readonly failure?: 'isolate' | 'propagate';
  readonly provides?: ResourceRequirements;
  bindDriver?(identity: Readonly<{ driverId: string }>): DriverObserver;
  bindInvocation(setup: InvocationObservationSetup, parent?: InvocationObserver): InvocationObserver;
  invalidate?(error: unknown): void;
}

/** Each binding grants this declaration a separate synchronous resource window. */
function bindObservation<Fact>(declaration: ObservationDeclaration<Fact>, resources: InvocationResources): (fact: Fact) => undefined {
  const binding = ResourceBinding.fromSupply(declaration.deps, resources.supply);
  return (fact: Fact): undefined => {
    const access = binding.open();
    try {
      return declaration.observe(fact, access.endpoints);
    } finally {
      access.close();
    }
  };
}

/** Connect installed consumers, parent inheritance and the declaration's requested resource ports. */
export function bindInvocationObservation(setup: InvocationObservationSetup, installations: readonly ObservationInstallation[] | undefined, parent?: InvocationObservation): InvocationObservation {
  const sessions: ObserverSession[] = [];
  const installed = new Map<ObservationInstallation, ObserverSession>();
  if (!installations) return new InvocationObservation(sessions, installed);
  for (const installation of installations) {
    const previous = parent?.sessionFor(installation);
    if (parent && (!previous || !previous.available())) continue;
    const observer = installation.bindInvocation(setup, previous?.observer);
    const session = new ObserverSession(observer, installation.failure ?? 'isolate', (error) => installation.invalidate?.(error), previous);
    installed.set(installation, session);
    sessions.push(session);
  }
  const suppliers = [...installed.values()];
  const resources = setup.resources.supplement(suppliers.flatMap((session) => (session.observer.resources ? [session.observer.resources] : [])));
  for (const declaration of setup.declarations ?? []) {
    const owner = declaration.installation ? installed.get(declaration.installation) : undefined;
    if (declaration.installation && !owner) continue;
    const requests = resourceRequests(declaration.deps);
    const unavailable = requests.some((request) => !resources.provides(request));
    if (unavailable) {
      // A disabled parent installation disables its descendant carrier only.
      const inherited = requests.every((request) => resources.provides(request) || installations.some((installation) => resourceRequests(installation.provides ?? {}).some((provided) => provided.offer === request.offer)));
      if (inherited) continue;
    }
    const dependencies = suppliers.filter((session) => session === owner || requests.some((request) => session.observer.resources?.provides(request)));
    const observe = bindObservation(declaration, resources);
    const available = () => dependencies.every((session) => session.available());
    const failure = declaration.failure ?? owner?.failure ?? (dependencies.some((session) => session.failure === 'propagate') ? 'propagate' : 'isolate');
    sessions.push(
      new ObserverSession({ observe, available }, failure, (error) => {
        for (const dependency of dependencies) dependency.stop(error);
      }),
    );
  }
  return new InvocationObservation(sessions, installed);
}

/** Driver observation uses stable driver identity, independently of invocation observations. */
export function bindDriverObservation(driverId: string, installations: readonly ObservationInstallation[] = []): EventConsumer<DriverFact> {
  const sessions = installations.flatMap((installation) => {
    const observer = installation.bindDriver?.(Object.freeze({ driverId }));
    return observer ? [new ObserverSession(observer, installation.failure ?? 'isolate', (error) => installation.invalidate?.(error))] : [];
  });
  return { publish: (fact) => publishSessions(sessions, (observer) => observer.observe(fact)) };
}
