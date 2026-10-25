import type { CallableContract } from '../callable/signature.js';

/** Consumer signature of a registered member; registration still requires a full structure. */
export type ChildContract = CallableContract<'group', any> | CallableContract<'node', any>;
