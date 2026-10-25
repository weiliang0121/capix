/** A completed operation; this does not claim that its consumer has accepted the result. */
export type OperationOutcome<Value, Failure = unknown> = { readonly status: 'succeeded'; readonly value: Value } | { readonly status: 'failed'; readonly failure: Failure };

/** Only the selected branch receives a result. An exception here is a reception failure. */
export interface Reception<Value, Failure = unknown, Result = Value> {
  readonly succeeded?: (value: Value) => Result | PromiseLike<Result>;
  readonly failed?: (failure: Failure) => Result | PromiseLike<Result>;
}

export interface OperationOptions<Value, Failure = unknown, Result = Value, Delta = never> {
  readonly delta?: [Delta] extends [never] ? never : (delta: Delta) => void;
  readonly result?: Reception<Value, Failure, Result>;
}

type CallbackResult<Callback, Fallback = never> = Callback extends (...args: never[]) => infer Result ? Awaited<Result> : Fallback;
// Keep absence in each union branch: an optional result or success handler may
// leave the original success value unchanged at runtime.
type PropertyValue<Owner, Key extends PropertyKey> = Owner extends unknown ? (Key extends keyof Owner ? Owner[Key] : undefined) : never;
type ResultReception<Options> = PropertyValue<Options, 'result'>;
type SuccessfulResult<Value, Handler> = [Handler] extends [never] ? Value : CallbackResult<PropertyValue<Handler, 'succeeded'>, Value>;
type FailedResult<Handler> = CallbackResult<PropertyValue<Handler, 'failed'>>;

/** Missing success handlers retain Value; a handled failure adds only its actual callback result. */
export type OperationResult<Value, Options> = SuccessfulResult<Value, ResultReception<Options>> | FailedResult<ResultReception<Options>>;
