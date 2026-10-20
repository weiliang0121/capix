import type { ObservationDeclaration, ObservationDeclarationScope } from '../definition/observation.js';
import { resourceRequests, type ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { InvocationFact, InvocationIdentity, InvocationDescription, DriverFact } from '../observation/facts.js';
import type { EventConsumer, InvocationObserver, DriverObserver } from '../observation/observer.js';
import { InvocationObservation } from '../observation/invocation.js';
import { ObserverSession, publishSessions } from '../observation/session.js';

export interface InvocationObservationSetup {
  readonly identity: InvocationIdentity;
  readonly description?: InvocationDescription;
  readonly declarations?: readonly ObservationDeclaration<InvocationFact>[];
  readonly resources: ResourceBindings;
}

export interface ObservationInstallation {
  check?(definition: ObservationDeclarationScope, parent?: ObservationDeclarationScope): void;
  readonly failure?: 'isolate' | 'propagate';
  readonly provides?: ResourceRequirements;
  bindDriver?(identity: Readonly<{ driverId: string }>): DriverObserver;
  bindInvocation(setup: InvocationObservationSetup, parent?: InvocationObserver): InvocationObserver;
  invalidate?(error: unknown): void;
}

/** Each binding grants this declaration a separate synchronous resource window. */
function bindObservation<Fact>(declaration: ObservationDeclaration<Fact>, resources: ResourceBindings): (fact: Fact) => undefined {
  const local = resources.select(declaration.requires);
  let active = false;
  let started = false;
  local.restrict(() => {
    if (!active) throw new Error('Observation access window has ended');
  });
  return (fact: Fact): undefined => {
    active = true;
    try {
      if (!started) {
        started = true;
        local.start();
      }
      return declaration.observe(fact, local.values);
    } finally {
      active = false;
    }
  };
}

/** Connect installed consumers, parent inheritance and the declaration's requested resource ports. */
export function bindInvocationObservation(setup: InvocationObservationSetup, installations: readonly ObservationInstallation[] | undefined, parent?: InvocationObservation): InvocationObservation {
  const sessions: ObserverSession[] = [];
  const installed = new Map<ObservationInstallation, ObserverSession>();
  if (!installations) return new InvocationObservation(sessions, installed);
  for (const installation of installations) {
    const previous = parent?.observerFor(installation);
    if (parent && (!previous || previous.available?.() === false)) continue;
    const observer = installation.bindInvocation(setup, previous);
    const session = new ObserverSession(observer, installation.failure ?? 'isolate', (error) => installation.invalidate?.(error));
    installed.set(installation, session);
    sessions.push(session);
  }
  const suppliers = [...installed.values()];
  const resources = setup.resources.supplement(suppliers.flatMap((session) => (session.observer.resources ? [session.observer.resources] : [])));
  for (const declaration of setup.declarations ?? []) {
    const requests = resourceRequests(declaration.requires);
    const unavailable = requests.some((request) => !resources.provides(request));
    if (unavailable) {
      // A disabled parent installation disables its descendant carrier only.
      const inherited = requests.every((request) => resources.provides(request) || installations.some((installation) => resourceRequests(installation.provides ?? {}).some((provided) => provided.offer === request.offer)));
      if (inherited) continue;
    }
    const dependencies = suppliers.filter((session) => requests.some((request) => session.observer.resources?.provides(request)));
    const observe = bindObservation(declaration, resources);
    const available = () => dependencies.every((session) => session.active && session.observer.available?.() !== false);
    const failure = declaration.failure ?? (dependencies.some((session) => session.failure === 'propagate') ? 'propagate' : 'isolate');
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
