import type { CallableKind } from '@capix/protocol';
import type { CallableDescription, CallableDefinition, EmptyResources, InferredCallableDefinition, InferredRunDefinition, InvocationExceptionDefinition, InvocationRunDefinition, StageAllowed, StageUses } from '../definition/callable.js';
import type { ChildContractsOf } from '../definition/children.js';
import type { invocationSignature, InvocationSignature } from '../definition/signature.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { ExecuteWork, AcceptWork, Continue, HandleWork, Resolution } from '../definition/work.js';
import type { ExceptionContract } from '../exception/contract.js';

type RunConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>, Delta> = {
  readonly requires?: ResourceRequests;
  readonly uses?: readonly ChildContractsOf<Kind>[];
  readonly execute: (work: ExecuteWork<Kind, Input, Output, Resources, Allowed, Delta>) => Output | Promise<Output>;
  readonly accept?: (work: AcceptWork<Kind, Input, Output, Resources, Allowed>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
};
type ExceptionConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>> = {
  readonly requires?: ResourceRequests;
  readonly uses?: readonly ChildContractsOf<Kind>[];
  readonly accepts: readonly ExceptionContract<unknown>[];
  readonly handle: (work: HandleWork<Kind, Input, Output, Resources, Allowed>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
};

/** Author object identity is stable; individual declaration phases can be replaced before binding. */
export abstract class Callable<Input, Output, Kind extends CallableKind, Delta = never> {
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
  // The current mechanism view deliberately makes no lasting resource promise.
  run?: InvocationRunDefinition<Input, Output, Kind, object, Delta>;
  exceptions?: InvocationExceptionDefinition<Input, Output, Kind, object>;

  protected constructor(kind: Kind) {
    this.kind = kind;
    Object.defineProperty(this, 'kind', { value: kind, enumerable: true, writable: false, configurable: false });
  }

  setRun<const Requires extends ResourceRequests = EmptyResources, const Uses extends StageUses<Kind> = undefined>(run: InferredRunDefinition<Input, Output, Kind, Requires, Uses, Delta>): this {
    const next = normalizeRun<Input, Output, Kind, ResourcesOf<Requires>, StageAllowed<Kind, Uses>, Delta>(run);
    this.run = next;
    return this;
  }

  setDefinition<const Requires extends ResourceRequests = EmptyResources, const Uses extends StageUses<Kind> = undefined, const ExceptionRequires extends ResourceRequests = EmptyResources, const ExceptionUses extends StageUses<Kind> = readonly []>(definition: InferredCallableDefinition<Input, Output, Kind, Requires, Uses, ExceptionRequires, ExceptionUses, Delta>): this {
    checkDefinition(definition);
    const run = normalizeRun<Input, Output, Kind, ResourcesOf<Requires>, StageAllowed<Kind, Uses>, Delta>(definition.run);
    const exceptions = definition.exceptions ? normalizeExceptions<Input, Output, Kind, ResourcesOf<ExceptionRequires>, ExceptionUses extends readonly ChildContractsOf<Kind>[] ? ExceptionUses[number] : never>(definition.exceptions) : undefined;
    this.replaceDefinition(definition, run, exceptions);
    return this;
  }

  protected configure<Resources extends object, ExceptionResources extends object>(definition: CallableDefinition<Input, Output, Kind, Resources, ExceptionResources, Delta>): void {
    checkDefinition(definition);
    const run = normalizeRun<Input, Output, Kind, Resources, ChildContractsOf<Kind>, Delta>(definition.run);
    const exceptions = definition.exceptions ? normalizeExceptions<Input, Output, Kind, ExceptionResources, ChildContractsOf<Kind>>(definition.exceptions) : undefined;
    this.replaceDefinition(definition, run, exceptions);
  }

  private replaceDefinition(description: CallableDescription<Input, Output, Kind, Delta>, run: InvocationRunDefinition<Input, Output, Kind, object, Delta>, exceptions: InvocationExceptionDefinition<Input, Output, Kind, object> | undefined): void {
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
      run,
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
    this.run = next.run;
    this.exceptions = next.exceptions;
  }
}

function checkDefinition(definition: { readonly maxRounds?: 1 | 2 }): void {
  if (!definition || typeof definition !== 'object') throw new TypeError('Callable definition must be an object');
  if ('kind' in definition || 'members' in definition) throw new TypeError('Callable kind and members are not business definition fields');
  if (definition.maxRounds !== undefined && definition.maxRounds !== 1 && definition.maxRounds !== 2) throw new TypeError('Callable maxRounds must be 1 or 2');
}

function normalizeRun<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>, Delta>(run: RunConfiguration<Input, Output, Kind, Resources, Allowed, Delta>): InvocationRunDefinition<Input, Output, Kind, object, Delta> {
  if (!run || typeof run.execute !== 'function') throw new TypeError('Callable run requires execute');
  if (run.accept !== undefined && typeof run.accept !== 'function') throw new TypeError('Callable accept must be a function');
  return { requires: run.requires ?? {}, uses: run.uses, execute: run.execute.bind(run), ...(run.accept ? { accept: run.accept.bind(run) } : {}) };
}

function normalizeExceptions<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind>>(exceptions: ExceptionConfiguration<Input, Output, Kind, Resources, Allowed>): InvocationExceptionDefinition<Input, Output, Kind, object> {
  if (typeof exceptions.handle !== 'function' || !Array.isArray(exceptions.accepts)) throw new TypeError('Callable exceptions require accepts and handle');
  return { requires: exceptions.requires ?? {}, uses: exceptions.uses, accepts: exceptions.accepts, handle: exceptions.handle.bind(exceptions) };
}
