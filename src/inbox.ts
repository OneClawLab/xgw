import type { Message } from './types.js';
import { execCommand } from './repo-utils/os.js';

export class InboxWriter {
  async push(
    agentId: string,
    message: Message,
    channelType: string,
    agentsConfig: Record<string, { inbox: string }>,
  ): Promise<void> {
    const agent = agentsConfig[agentId];
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in config`);
    }

    // Format source address: external:<channel_type>:<channel_id>:<session_type>:<session_id>:<peer_id>
    const source = `external:${channelType}:${message.channel_id}:dm:${message.conversation_id}:${message.peer_id}`;

    // Build content JSON — exclude raw field
    const { raw, ...content } = message;
    const contentJson = JSON.stringify(content);

    await execCommand('thread', [
      'push',
      '--thread', agent.inbox,
      '--source', source,
      '--type', 'message',
      '--content', contentJson,
    ]);
  }
}
