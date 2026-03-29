import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Config } from '../config.js';
import type { GatewayStats, Message } from '../types.js';
import { Router } from './router.js';
import { InboxWriter } from '../inbox.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { Logger } from '../repo-utils/logger.js';
import type { XarClient } from '../xar/client.js';
import { Dispatcher } from '../xar/dispatcher.js';

export class GatewayServer {
  private server: Server | null = null;
  private router: Router;
  private inbox: InboxWriter;
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
    this.inbox = new InboxWriter();
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

    // Create onMessage handler: plugin → router → xarClient (or inbox fallback)
    const onMessage = async (msg: Message): Promise<void> => {
      this.messagesIn++;
      const agentId = this.router.resolve(msg.channel_id, msg.peer_id);
      if (!agentId) {
        this.logger.warn(
          `routing miss: channel=${msg.channel_id} peer=${msg.peer_id} (no matching rule)`,
        );
        return;
      }

      // Determine channel type from config
      const ch = config.channels.find((c) => c.id === msg.channel_id);
      const channelType = ch?.type ?? 'unknown';

      this.logger.info(
        `inbound: channel=${msg.channel_id} peer=${msg.peer_id} → agent=${agentId} msg_id=${msg.id}`,
      );

      if (this.xarClient) {
        // v2: send via XarClient IPC
        const source = `external:${channelType}:${msg.channel_id}:dm:${msg.session_id}:${msg.peer_id}`;
        await this.xarClient.sendInbound(agentId, {
          source,
          content: msg.text,
          reply_context: {
            channel_type: channelType,
            channel_id: msg.channel_id,
            session_type: 'dm',
            session_id: msg.session_id,
            peer_id: msg.peer_id,
          },
        });
        this.logger.info(`xar send: agent=${agentId}`);
      } else {
        // v1 fallback: push via InboxWriter (for xgw send CLI / diagnostics)
        await this.inbox.push(agentId, msg, channelType, config.agents);
        this.logger.info(`inbox push: agent=${agentId} thread=${config.agents[agentId]?.inbox}`);
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
