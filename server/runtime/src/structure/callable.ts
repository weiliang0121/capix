import { randomUUID } from 'node:crypto';
import type { CallableKind } from '@capix/protocol';
import { initializeStructureConfiguration, assertStructureConfigurable } from './configuration.js';
import type { CallableDescription, CallableDefinition, CallableRun, CallableRunOptions, EmptyResources, InferredCallableDefinition, InvocationExceptionDefinition, CallableRunDefinition, StageAllowed, StageUses } from '../definition/callable.js';
import type { ChildContractsOf } from '../definition/children.js';
import type { invocationSignature, InvocationSignature } from '../definition/signature.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { ExecuteWork, AcceptWork, Continue, HandleWork, Resolution } from '../definition/work.js';
import type { ExceptionContract } from '../exception/contract.js';

type RunConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>, Delta> = {
  readonly deps?: ResourceRequests;
  readonly uses?: readonly ChildContractsOf<Kind>[];
  readonly run: (work: ExecuteWork<Kind, Input, Output, Resources, Allowed, Delta>) => Output | Promise<Output>;
  readonly accept?: (work: AcceptWork<Kind, Input, Output, Resources, Allowed>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
};
type ExceptionConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>> = {
  readonly deps?: ResourceRequests;
  readonly uses?: readonly ChildContractsOf<Kind>[];
  readonly accepts: readonly ExceptionContract<unknown>[];
  readonly handle: (work: HandleWork<Kind, Input, Output, Resources, Allowed>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
};

type RunArguments<Deps extends ResourceRequests, Options> = [keyof Deps] extends [never] ? [deps?: Deps, options?: Options] : [deps: Deps, options?: Options];

/** Heterogeneous registration reads configuration, never another object's author setters. */
export type CallableStructure<Kind extends CallableKind> = Omit<Callable<any, any, Kind, any>, 'setRun' | 'setDefinition'>;

/** Author object identity is stable; individual declaration phases can be replaced before binding. */
export abstract class Callable<Input, Output, Kind extends CallableKind, Delta = never> {
  readonly id = randomUUID();
  readonly kind: Kind;
  declare readonly [invocationSignature]: InvocationSignature<Input, Output, Delta>;
  name?: string;
  label?: string;
  source?: string;
  callee?: string;
  maxRounds: 1 | 2 = 1;
  raises: readonly ExceptionContract<unknown>[] = [];
  output?: CallableDescription<Input, Output, Kind, Delta>['output'];
  observation?: CallableDescription<Input, Output, Kind, Delta>['observation'];
  checkpoint?: CallableDescription<Input, Output, Kind, Delta>['checkpoint'];
  receptions?: CallableDescription<Input, Output, Kind, Delta>['receptions'];
  // Resources are inferred per configuration call, not promised across later setters.
  deps: CallableRunDefinition<Input, Output, Kind, object, Delta>['deps'] = {};
  uses?: CallableRunDefinition<Input, Output, Kind, object, Delta>['uses'];
  run?: CallableRunDefinition<Input, Output, Kind, object, Delta>['run'];
  accept?: CallableRunDefinition<Input, Output, Kind, object, Delta>['accept'];
  exceptions?: InvocationExceptionDefinition<Input, Output, Kind, object>;

  protected constructor(kind: Kind) {
    initializeStructureConfiguration(this);
    this.kind = kind;
    Object.defineProperty(this, 'kind', { value: kind, enumerable: true, writable: false, configurable: false });
  }

  /** A bare function becomes this structure's method; bound functions retain their receiver. */
  setRun<const Deps extends ResourceRequests = EmptyResources, const Uses extends StageUses<Kind> = undefined>(run: CallableRun<Input, Output, Kind, ResourcesOf<NoInfer<Deps>>, StageAllowed<Kind, Uses>, Delta, this>, ...configuration: RunArguments<Deps, CallableRunOptions<Input, Output, Kind, ResourcesOf<NoInfer<Deps>>, Uses, this>>): this;
  setRun<const Deps extends ResourceRequests = EmptyResources, const Uses extends StageUses<Kind> = undefined>(run: CallableRun<Input, Output, Kind, ResourcesOf<Deps>, StageAllowed<Kind, Uses>, Delta>, deps?: Deps, options?: CallableRunOptions<Input, Output, Kind, ResourcesOf<Deps>, Uses>): this {
    assertStructureConfigurable(this);
    if (typeof run !== 'function') throw new TypeError('Callable run must be a function');
    const next = captureRun<Input, Output, Kind, ResourcesOf<Deps>, StageAllowed<Kind, Uses>, Delta>({ deps, uses: options?.uses, run, accept: options?.accept }, this);
    this.replaceRun(next);
    return this;
  }

  setDefinition<const Deps extends ResourceRequests = EmptyResources, const Uses extends StageUses<Kind> = undefined, const ExceptionDeps extends ResourceRequests = EmptyResources, const ExceptionUses extends StageUses<Kind> = readonly []>(definition: InferredCallableDefinition<Input, Output, Kind, Deps, Uses, ExceptionDeps, ExceptionUses, Delta>): this {
    assertStructureConfigurable(this);
    checkDefinition(definition);
    const run = captureRun<Input, Output, Kind, ResourcesOf<Deps>, StageAllowed<Kind, Uses>, Delta>(definition, definition);
    const exceptions = definition.exceptions ? normalizeExceptions<Input, Output, Kind, ResourcesOf<ExceptionDeps>, ExceptionUses extends readonly ChildContractsOf<Kind>[] ? ExceptionUses[number] : never>(definition.exceptions) : undefined;
    this.replaceDefinition(definition, run, exceptions);
    return this;
  }

  protected configure<Resources extends object, ExceptionResources extends object>(definition: CallableDefinition<Input, Output, Kind, Resources, ExceptionResources, Delta>): void {
    assertStructureConfigurable(this);
    checkDefinition(definition);
    const run = captureRun<Input, Output, Kind, Resources, ChildContractsOf<Kind>, Delta>(definition, definition);
    const exceptions = definition.exceptions ? normalizeExceptions<Input, Output, Kind, ExceptionResources, ChildContractsOf<Kind>>(definition.exceptions) : undefined;
    this.replaceDefinition(definition, run, exceptions);
  }

  private replaceDefinition(description: CallableDescription<Input, Output, Kind, Delta>, run: CallableRunDefinition<Input, Output, Kind, object, Delta>, exceptions: InvocationExceptionDefinition<Input, Output, Kind, object> | undefined): void {
    // Read every field before changing this object, including possible host accessors.
    const next = {
      name: description.name,
      label: description.label,
      source: description.source,
      callee: description.callee,
      maxRounds: description.maxRounds ?? 1,
      raises: description.raises ?? [],
      output: description.output,
      observation: description.observation,
      checkpoint: description.checkpoint,
      receptions: description.receptions,
      ...run,
      exceptions,
    };
    this.name = next.name;
    this.label = next.label;
    this.source = next.source;
    this.callee = next.callee;
    this.maxRounds = next.maxRounds;
    this.raises = next.raises;
    this.output = next.output;
    this.observation = next.observation;
    this.checkpoint = next.checkpoint;
    this.receptions = next.receptions;
    this.replaceRun(next);
    this.exceptions = next.exceptions;
  }
  private replaceRun(run: CallableRunDefinition<Input, Output, Kind, object, Delta>): void {
    this.deps = run.deps;
    this.uses = run.uses;
    this.run = run.run;
    this.accept = run.accept;
  }
}

function checkDefinition(definition: { readonly maxRounds?: 1 | 2 }): void {
  if (!definition || typeof definition !== 'object') throw new TypeError('Callable definition must be an object');
  if ('kind' in definition || 'members' in definition) throw new TypeError('Callable kind and members are not business definition fields');
  if (definition.maxRounds !== undefined && definition.maxRounds !== 1 && definition.maxRounds !== 2) throw new TypeError('Callable maxRounds must be 1 or 2');
}

/** Capture processing once, preserving the config receiver or the structure's setRun receiver. */
function captureRun<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>, Delta>(configuration: RunConfiguration<Input, Output, Kind, Resources, Allowed, Delta>, receiver: object): CallableRunDefinition<Input, Output, Kind, object, Delta> {
  const { deps, uses, run, accept } = configuration;
  if (typeof run !== 'function') throw new TypeError('Callable run must be a function');
  if (accept !== undefined && typeof accept !== 'function') throw new TypeError('Callable accept must be a function');
  return { deps: deps ?? {}, uses, run: run.bind(receiver), accept: accept?.bind(receiver) };
}

function normalizeExceptions<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>>(exceptions: ExceptionConfiguration<Input, Output, Kind, Resources, Allowed>): InvocationExceptionDefinition<Input, Output, Kind, object> {
  if (typeof exceptions.handle !== 'function' || !Array.isArray(exceptions.accepts)) throw new TypeError('Callable exceptions require accepts and handle');
  return { deps: exceptions.deps ?? {}, uses: exceptions.uses, accepts: exceptions.accepts, handle: exceptions.handle.bind(exceptions) };
}
