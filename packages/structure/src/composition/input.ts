import type { CallableInput, ChildContract } from '@weiliang0121/capix-contracts';

/** An unresolved member union needs input accepted by every possible selected member. */
export type MemberInput<Member extends ChildContract> = (Member extends unknown ? (input: CallableInput<Member>) => void : never) extends (input: infer Input) => void ? Input : never;
