import type { OperationOptions, OperationResult } from '@capix/contracts';
import type { ResourceEndpointActivity } from './endpoint.js';

/** A producer endpoint belonging to one resource operation, sealed when that operation returns. */
export interface ResourceOperation<Delta = never> {
  readonly signal: AbortSignal | undefined;
  emit(delta: Delta): void;
  /** Synchronous cleanup when this operation finishes, its window closes, or its signal aborts. */
  onClose(cleanup: (reason: unknown) => void): () => void;
}

export type ResourceMethodDeclarations = Readonly<Record<string, (origin: never, input: never, operation: never) => unknown>>;
type MethodArguments<Method> = Method extends (...args: infer Arguments) => unknown ? Arguments : never;
type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (value: infer Intersection) => void ? Intersection : never;
export type ResourceMethodsSource<Methods extends ResourceMethodDeclarations> = UnionToIntersection<MethodArguments<Methods[keyof Methods]>[0]>;
type MethodInput<Method> = MethodArguments<Method> extends [unknown, infer Input, ...unknown[]] ? Input : void;
type MethodOutput<Method> = Method extends (...args: never[]) => infer Output ? Awaited<Output> : never;
type MethodDelta<Method> = MethodArguments<Method> extends [unknown, unknown, ResourceOperation<infer Delta>, ...unknown[]] ? Delta : never;

export type ResourceMethods<Methods extends ResourceMethodDeclarations> = {
  readonly [Name in keyof Methods]: <const Options extends OperationOptions<MethodOutput<Methods[Name]>, unknown, unknown, MethodDelta<Methods[Name]>> = {}>(input: MethodInput<Methods[Name]>, options?: Options & OperationOptions<MethodOutput<Methods[Name]>, unknown, unknown, MethodDelta<Methods[Name]>>) => Promise<OperationResult<MethodOutput<Methods[Name]>, Options>>;
};

export interface ResourceMethodsDeclaration<Methods extends ResourceMethodDeclarations, Source = ResourceMethodsSource<Methods>, Selection = never> {
  readonly name?: string;
  readonly methods: Methods;
  readonly expose?: never;
  readonly timing?: 'binding' | 'access';
  readonly capture?: (source: Source) => ResourceMethodsSource<Methods>;
  readonly refine?: (captured: ResourceMethodsSource<Methods>, selection: Selection) => ResourceMethodsSource<Methods>;
  readonly observation?: ResourceMethodsObservation<Methods>;
}

/** Explicit observation projections; runtime never assumes that input or output is safe to record. */
export interface ResourceMethodsObservation<Methods extends ResourceMethodDeclarations> {
  readonly source?: (source: ResourceMethodsSource<Methods>) => unknown;
  readonly methods?: {
    readonly [Name in keyof Methods]?: {
      readonly input?: (input: MethodInput<Methods[Name]>) => unknown;
      readonly output?: (output: MethodOutput<Methods[Name]>) => unknown;
    };
  };
}

/** Explicit methods are the operation boundary; properties on the entity are never intercepted. */
export function resourceMethods<Methods extends ResourceMethodDeclarations>(methods: Methods, observation?: ResourceMethodsObservation<Methods>): (origin: ResourceMethodsSource<Methods>, activity: ResourceEndpointActivity) => ResourceMethods<Methods> {
  const entries = Object.entries(methods).map(([name, method]) => {
    if (typeof method !== 'function') throw new TypeError(`Resource method must be a function: ${name}`);
    const description = observation?.methods?.[name];
    return { name, execute: method.bind(methods), input: description?.input?.bind(description), output: description?.output?.bind(description) };
  });
  return (origin, activity) => Object.freeze(Object.fromEntries(entries.map((method) => [method.name, (input: unknown, options?: OperationOptions<unknown, unknown, unknown, unknown>) => activity.operate(method.name, { input: () => method.input?.(input as never), output: (output) => method.output?.(output as never) }, (operation) => method.execute(origin as never, input as never, operation as never), options)]))) as ResourceMethods<Methods>;
}
