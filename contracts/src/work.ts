import type { Stable } from './value.js';
import type { ChildCalls, ChildContract, ResumeChildCalls } from './children/index.js';
import type { BusinessEvent } from './observation.js';
import type { InvocationOutputWriter } from './output.js';

/** Business processing sees its input and current controlled operation endpoints. */
export interface Work<Input, Resources extends object> {
  readonly input: Stable<Input>;
  readonly resources: Readonly<Resources>;
  readonly signal: AbortSignal;
  observation(event: BusinessEvent): void;
}

export interface CompositeWork<Allowed extends ChildContract = ChildContract, Restoring extends boolean = false> {
  readonly children: Restoring extends true ? ResumeChildCalls<Allowed> : ChildCalls<Allowed>;
}
/** Only producers that declare Delta receive the corresponding writer. */
export type OutputWork<Delta> = [Delta] extends [never] ? object : { readonly output: InvocationOutputWriter<Delta> };
