import type {RemoteCommand} from '../../../lib/types.js';

/** Build the receive envelope used by Web Inspector for target responses and events. */
export function targetMessage(targetId: string, message: Record<string, unknown>, appIdKey = 'app') {
  return dataMessage(
    {method: 'Target.dispatchMessageFromTarget', params: {targetId, message: JSON.stringify(message)}},
    appIdKey,
  );
}

export function dataMessage(message: Record<string, unknown>, appIdKey = 'app') {
  return {
    __selector: '_rpc_applicationSentData:',
    __argument: {
      WIRApplicationIdentifierKey: appIdKey,
      WIRMessageDataKey: Buffer.from(JSON.stringify(message)),
    },
  };
}

/** Decode a target-directed outgoing command for protocol assertions. */
export function commandFrom(message: RemoteCommand) {
  const wrapper = JSON.parse(String(message.__argument.WIRSocketDataKey));
  return {...JSON.parse(wrapper.params.message), targetId: wrapper.params.targetId};
}
