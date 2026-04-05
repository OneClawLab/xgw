import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Config } from '../config.js';
import type { GatewayStats, Message } from '../types.js';
import { Router } from './router.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { Logger } from '../repo-utils/logger.js';
import type { XarClient } from '../xar/client.js';
import { Dispatcher } from '../xar/dispatcher.js';

export class GatewayServer {
  private server: Server | null = null;
  private router: Router;
  private logger: Logger;
  private startTime = 0;
  private messagesIn = 0;
  private messagesOut = 0;
  private config: Config | null = null;
  private registry: ChannelRegistry | null = null;
  private xarClient: XarClient | undefined;
  private dispatcher: Dispatcher | undefined;

  constructor(logger: Logger, xarClient?: XarClient) {
    this.router = new Router();
    this.logger = logger;
    this.xarClient = xarClient;
  }

  async start(config: Config, registry: ChannelRegistry): Promise<void> {
    this.config = config;
    this.registry = registry;
    this.router.reload(config.routing);
    this.startTime = Date.now();

    // Connect XarClient and wire up Dispatcher if provided
    if (this.xarClient) {
      this.dispatcher = new Dispatcher(registry, this.logger);
      const dispatcher = this.dispatcher;
      const logger = this.logger;
      this.xarClient.onOutbound((event) => {
        try {
          dispatcher.handle(event);
        } catch (err) {
          logger.error(`Dispatcher error handling event type=${event.type}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      await this.xarClient.connect();
    }

    // Create onMessage handler: plugin → router → xarClient
    const onMessage = async (msg: Message): Promise<void> => {
      this.messagesIn++;
      const agentId = this.router.resolve(msg.channel_id, msg.peer_id);
      if (!agentId) {
        this.logger.warn(
          `routing miss: channel=${msg.channel_id} peer=${msg.peer_id} (no matching rule)`,
        );
        const plugin = registry.getPlugin(msg.channel_id);
        if (plugin) {
          try {
            await plugin.send({
              peer_id: msg.peer_id,
              conversation_id: msg.conversation_id,
              text: `[xgw] No agent configured for this channel. Check routing rules in xgw config.`,
            });
          } catch {
            // best-effort — plugin may not be able to send
          }
        }
        return;
      }

      this.logger.info(
        `inbound: channel=${msg.channel_id} peer=${msg.peer_id} → agent=${agentId} msg_id=${msg.id}`,
      );

      if (this.xarClient) {
        // Build source address: external:<channel_id>:<conversation_type>:<conversation_id>:<peer_id>
        // channel_id is already in <type>:<instance> format
        const source = `external:${msg.channel_id}:${msg.conversation_type}:${msg.conversation_id}:${msg.peer_id}`;

        // Mention gating is now handled by xar based on the agent's routing
        // config (mode + trigger). xgw transparently passes through `mentioned`
        // and `conversation_type` so xar can make the correct decision.
        // Requirement 9.1
        const status = await this.xarClient.sendInbound(agentId, {
          source,
          content: msg.text,
          ...(msg.mentioned !== undefined && { mentioned: msg.mentioned }),
          ...(msg.conversation_type !== undefined && { conversation_type: msg.conversation_type }),
        });

        if (status === 'buffered') {
          this.logger.warn(`xar disconnected, message buffered: agent=${agentId} peer=${msg.peer_id}`);
          const plugin = registry.getPlugin(msg.channel_id);
          if (plugin) {
            try {
              await plugin.send({
                peer_id: msg.peer_id,
                conversation_id: msg.conversation_id,
                text: `[xgw] Agent backend temporarily unavailable — message queued, will be delivered when connection restores.`,
              });
            } catch { /* best-effort */ }
          }
        } else {
          this.logger.info(`xar send: agent=${agentId}`);
        }
      } else {
        this.logger.warn(`No xar client configured, message dropped: agent=${agentId} peer=${msg.peer_id}`);
      }
    };

    // Start all paired channels
    await registry.startAll(config.channels, onMessage);

    // Create HTTP server
    this.server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(config.gateway.port, config.gateway.host, () => {
        this.logger.info(
          `gateway listening on ${config.gateway.host}:${config.gateway.port}`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.registry) {
      await this.registry.stopAll();
    }
    if (this.xarClient) {
      this.xarClient.close();
    }
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = null;
    }
  }

  getStats(): GatewayStats {
    return {
      uptime: this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
      channelStats: {},
    };
  }

  incrementOutbound(): void {
    this.messagesOut++;
  }

  reload(config: Config): void {
    this.config = config;
    this.router.reload(config.routing);
  }
}
