import type { Logger } from '../repo-utils/logger.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { XarOutboundEvent, SessionState } from './types.js';

export class Dispatcher {
  private readonly registry: ChannelRegistry;
  private readonly logger: Logger;

  /** session_id → SessionState */
  private sessions = new Map<string, SessionState>();

  constructor(registry: ChannelRegistry, logger: Logger) {
    this.registry = registry;
    this.logger = logger;
  }

  handle(event: XarOutboundEvent): void {
    switch (event.type) {
      case 'stream_start': {
        const { session_id, reply_context } = event;
        const state: SessionState = {
          channelId: reply_context.channel_id,
          channelType: reply_context.channel_type,
          peerId: reply_context.peer_id,
          sessionId: session_id,
          tokenBuffer: [],
        };
        this.sessions.set(session_id, state);
        break;
      }

      case 'stream_token': {
        const { session_id, token } = event;
        const state = this.sessions.get(session_id);
        if (!state) {
          this.logger.warn(`Dispatcher: stream_token for unknown session ${session_id}, discarding`);
          return;
        }
        const plugin = this.registry.getPlugin(state.channelId);
        if (!plugin) {
          this.logger.warn(`Dispatcher: no plugin for channel ${state.channelId}, discarding stream_token`);
          return;
        }
        if (state.channelType === 'tui') {
          // TUI: send each token immediately
          void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: token });
        } else {
          // Non-TUI: accumulate tokens
          state.tokenBuffer.push(token);
        }
        break;
      }

      case 'stream_end': {
        const { session_id } = event;
        const state = this.sessions.get(session_id);
        if (!state) {
          this.logger.warn(`Dispatcher: stream_end for unknown session ${session_id}, discarding`);
          return;
        }
        if (state.channelType !== 'tui') {
          // Non-TUI: send the full accumulated text
          const plugin = this.registry.getPlugin(state.channelId);
          if (!plugin) {
            this.logger.warn(`Dispatcher: no plugin for channel ${state.channelId}, discarding stream_end`);
          } else {
            const fullText = state.tokenBuffer.join('');
            void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: fullText });
          }
        }
        // Clean up session state
        this.sessions.delete(session_id);
        break;
      }

      case 'stream_error': {
        const { session_id, error } = event;
        this.logger.error(`Dispatcher: stream_error for session ${session_id}: ${error}`);
        // Clean up session state
        this.sessions.delete(session_id);
        break;
      }

      case 'stream_thinking': {
        // Intentionally ignored — does not affect output
        break;
      }
    }
  }
}
