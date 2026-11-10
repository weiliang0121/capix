import { ProgressChannel } from '@weiliang0121/capix-changes';
import type { InvocationOutputReceiver } from '@weiliang0121/capix-contracts';

/** Explicit receivers remain independent even when installed on the same invocation. */
export function combineOutputReceivers<Result, Delta = unknown>(...receivers: readonly (InvocationOutputReceiver<Result, Delta> | undefined)[]): InvocationOutputReceiver<Result, Delta> | undefined {
  const channels = receivers.filter((receiver) => receiver !== undefined).map((receiver) => new ProgressChannel(receiver));
  if (!channels.length) return undefined;
  return {
    receive: (event): undefined => {
      for (const channel of channels) channel.publish(event);
    },
  };
}
