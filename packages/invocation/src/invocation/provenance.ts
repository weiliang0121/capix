import { DeclaredException } from '../exception/contract.js';
import type { InvocationContext } from '../context/context.js';
import { InvocationStopped } from './stop.js';

/** Exact direct relationship identity. A composition key is deliberately absent. */
export interface InvocationExceptionChild {
  readonly parentContextId: string;
  readonly childContextId: string;
  readonly parentRound: number;
  readonly order: number;
}

export type InvocationExceptionOrigin = Readonly<{ kind: 'self'; phase: 'execute' | 'accept' } | { kind: 'child-return' | 'child-reception'; child: InvocationExceptionChild }>;

export interface InvocationPropagationScope {
  readonly owner: object;
  readonly parentContextId: string;
  readonly round: number;
  readonly phase: 'execute' | 'receive' | 'handling';
}

interface Propagation {
  readonly scope: InvocationPropagationScope;
  readonly exception: DeclaredException;
  readonly origin: InvocationExceptionOrigin;
}

const credentials = new WeakMap<ChildCallFailure, Propagation>();

/** A child boundary's rejected delivery. Rethrow this value to preserve its source.
 * Throwing exception instead is a new local throw with a local source. */
export class ChildCallFailure extends Error {
  constructor(readonly exception: DeclaredException) {
    super(exception.message, { cause: exception });
    this.name = 'ChildCallFailure';
  }
}

/** Diagnostic inspection is not authentication or permission to propagate. */
export function inspectChildCallFailure(value: unknown): Readonly<{ exception: DeclaredException; origin: InvocationExceptionOrigin }> | undefined {
  const credential = value instanceof ChildCallFailure ? credentials.get(value) : undefined;
  return credential ? Object.freeze({ exception: credential.exception, origin: credential.origin }) : undefined;
}

/** Authentication belongs to one live parent, phase and round, never to Error identity. */
export class InvocationProvenance {
  readonly #owner = Object.freeze({});
  constructor(private readonly context: InvocationContext) {}

  capture(): InvocationPropagationScope {
    return Object.freeze({ owner: this.#owner, parentContextId: this.context.id, round: this.context.progress.round, phase: this.context.progress.phase });
  }

  resolve(value: unknown): ReturnType<typeof inspectChildCallFailure> {
    if (!(value instanceof ChildCallFailure)) return undefined;
    const credential = credentials.get(value);
    const scope = credential?.scope;
    if (!credential || !scope) throw new InvocationStopped('INVALID_EXCEPTION_DELIVERY', '子调用异常交付没有有效凭据。', undefined, { cause: value });
    this.require(scope, value);
    return Object.freeze({ exception: credential.exception, origin: credential.origin });
  }

  require(scope: InvocationPropagationScope, cause?: unknown): void {
    if (scope.owner !== this.#owner || scope.parentContextId !== this.context.id || scope.round !== this.context.progress.round || scope.phase !== this.context.progress.phase || this.context.status !== 'running') throw new InvocationStopped('INVALID_EXCEPTION_DELIVERY', '子调用异常交付不属于当前父调用、阶段或轮次。', undefined, { cause });
  }

  deliver(scope: InvocationPropagationScope, exception: DeclaredException, origin: InvocationExceptionOrigin): ChildCallFailure {
    if (scope.owner !== this.#owner) throw new Error('Exception delivery scope belongs to another parent');
    const stableOrigin: InvocationExceptionOrigin = origin.kind === 'self' ? Object.freeze({ ...origin }) : Object.freeze({ ...origin, child: Object.freeze({ ...origin.child }) });
    const delivery = new ChildCallFailure(exception);
    credentials.set(delivery, Object.freeze({ scope, exception, origin: stableOrigin }));
    return Object.freeze(delivery);
  }
}
