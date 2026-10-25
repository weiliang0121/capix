/** Identity is an opaque offer token. UUID identifies it in facts; name is descriptive. */
export interface ResourceIdentity {
  readonly id: string;
  readonly name: string;
}

declare const resourceValue: unique symbol;

/** A typed request does not resolve supplies or retain an endpoint. */
export class ResourceRequest<Value> {
  declare readonly [resourceValue]: Value;

  constructor(readonly offer: ResourceIdentity) {
    Object.freeze(this);
  }
}

export type ResourceRequirements<Resources extends object = object> = { readonly [Key in keyof Resources]: ResourceRequest<Resources[Key]> };
export type ResourceRequests = Readonly<Record<string, ResourceRequest<unknown>>>;
export type ResourcesOf<Deps extends ResourceRequests> = { readonly [Key in keyof Deps]: Deps[Key] extends ResourceRequest<infer Value> ? Value : never };

export function resourceRequests<Resources extends object>(deps: ResourceRequirements<Resources>): readonly ResourceRequest<unknown>[] {
  return Object.keys(deps).map((name) => deps[name as keyof Resources]);
}

export function checkResourceRequests(available: ResourceRequirements, requested: readonly ResourceRequest<unknown>[]): void {
  const offers = new Set(resourceRequests(available).map((request) => request.offer));
  for (const request of requested) {
    if (!offers.has(request.offer)) throw new Error(`Child resource request is not provided: ${request.offer.name}`);
  }
}
