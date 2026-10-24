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

type CallbackResult<Callback> = Callback extends (...args: never[]) => infer Result ? Awaited<Result> : never;
type ResultReception<Options> = Options extends { readonly result?: infer Result } ? NonNullable<Result> : never;
type SuccessfulResult<Value, Handler> = [Handler] extends [never] ? Value : Handler extends { readonly succeeded: infer Callback } ? CallbackResult<Callback> : Handler extends { readonly succeeded?: infer Callback } ? Value | CallbackResult<Callback> : Value;
type FailedResult<Handler> = Handler extends { readonly failed?: infer Callback } ? CallbackResult<Callback> : never;

/** Missing success handlers retain Value; a handled failure adds only its actual callback result. */
export type OperationResult<Value, Options> = SuccessfulResult<Value, ResultReception<Options>> | FailedResult<ResultReception<Options>>;
