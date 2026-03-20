import type { SendParams, SendResult } from '../types.js';
import type { ChannelRegistry } from '../channels/registry.js';

export class SendHandler {
  async send(
    channelId: string,
    params: SendParams,
    registry: ChannelRegistry,
  ): Promise<SendResult> {
    const plugin = registry.getPlugin(channelId);
    if (!plugin) {
      return {
        success: false,
        channel_id: channelId,
        peer_id: params.peer_id,
        error: `No plugin found for channel ${channelId}`,
      };
    }

    try {
      await plugin.send(params);
      return {
        success: true,
        channel_id: channelId,
        peer_id: params.peer_id,
      };
    } catch (err) {
      return {
        success: false,
        channel_id: channelId,
        peer_id: params.peer_id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
