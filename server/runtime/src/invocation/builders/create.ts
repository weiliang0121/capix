import { CallableContextBuilder } from '../../context/builders/callable.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { CallableInvocationBuilder } from './callable.js';

/** One installation owns one reusable builder; no call input or window is cached here. */
export function createInvocationBuilder(capabilities: InvocationCapabilities = {}): CallableInvocationBuilder {
  return new CallableInvocationBuilder(new CallableContextBuilder(), capabilities);
}
