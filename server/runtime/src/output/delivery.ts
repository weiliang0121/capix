import { ProgressChannel } from '../progress.js';
import type { InvocationOutputReceiver } from './contract.js';

/** Explicit receivers remain independent even when installed on the same invocation. */
export function combineOutputReceivers<Result>(...receivers: readonly (InvocationOutputReceiver<Result> | undefined)[]): InvocationOutputReceiver<Result> | undefined {
  const channels = receivers.filter((receiver) => receiver !== undefined).map((receiver) => new ProgressChannel(receiver));
  if (!channels.length) return undefined;
  return {
    receive: (event): undefined => {
      for (const channel of channels) channel.publish(event);
    },
  };
}
