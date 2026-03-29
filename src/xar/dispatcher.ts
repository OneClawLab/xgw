import type { Logger } from '../repo-utils/logger.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { XarOutboundEvent, SessionState } from './types.js';

const TUI_FLUSH_INTERVAL_MS = 100;

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
          flushTimer: null,
        };
        this.sessions.set(session_id, state);
        this.logger.info(`stream_start: session=${session_id} channel=${reply_context.channel_id} peer=${reply_context.peer_id}`);
        break;
      }

      case 'stream_token': {
        const { session_id, token } = event;
        const state = this.sessions.get(session_id);
        if (!state) {
          this.logger.warn(`Dispatcher: stream_token for unknown session ${session_id}, discarding`);
          return;
        }
        state.tokenBuffer.push(token);
        if (state.channelType === 'tui') {
          // TUI: schedule a batched flush if not already pending
          if (state.flushTimer === null) {
            state.flushTimer = setTimeout(() => {
              this.flushTuiBuffer(state);
            }, TUI_FLUSH_INTERVAL_MS);
          }
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
        if (state.channelType === 'tui') {
          // Cancel pending timer and flush remaining tokens, then send stream_end
          if (state.flushTimer !== null) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
          }
          this.flushTuiBuffer(state);
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: '', stream: 'end' });
          }
          this.logger.info(`stream_end: session=${session_id} channel=${state.channelId} peer=${state.peerId} (tui streaming complete)`);
        } else {
          // Non-TUI: send the full accumulated text
          const plugin = this.registry.getPlugin(state.channelId);
          if (!plugin) {
            this.logger.warn(`Dispatcher: no plugin for channel ${state.channelId}, discarding stream_end`);
          } else {
            const fullText = state.tokenBuffer.join('');
            this.logger.info(`stream_end: session=${session_id} channel=${state.channelId} peer=${state.peerId} chars=${fullText.length}`);
            void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: fullText });
          }
        }
        this.sessions.delete(session_id);
        break;
      }

      case 'stream_error': {
        const { session_id, error } = event;
        const state = this.sessions.get(session_id);
        if (state?.flushTimer !== null && state?.flushTimer !== undefined) {
          clearTimeout(state.flushTimer);
        }
        this.logger.error(`Dispatcher: stream_error for session ${session_id}: ${error}`);
        this.sessions.delete(session_id);
        break;
      }

      case 'stream_thinking': {
        const { session_id, delta } = event;
        const state = this.sessions.get(session_id);
        if (!state) return;
        if (state.channelType === 'tui') {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: delta, progress: 'thinking' });
          }
        }
        break;
      }

      case 'stream_tool_call': {
        const { session_id, tool_call } = event;
        const state = this.sessions.get(session_id);
        if (!state) return;
        if (state.channelType === 'tui') {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(tool_call), progress: 'tool_call' });
          }
        }
        break;
      }

      case 'stream_tool_result': {
        const { session_id, tool_result } = event;
        const state = this.sessions.get(session_id);
        if (!state) return;
        if (state.channelType === 'tui') {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(tool_result), progress: 'tool_result' });
          }
        }
        break;
      }

      case 'stream_ctx_usage': {
        const { reply_context, ctx_usage } = event;
        if (reply_context.channel_type === 'tui') {
          const plugin = this.registry.getPlugin(reply_context.channel_id);
          if (plugin) {
            void plugin.send({ peer_id: reply_context.peer_id, session_id: reply_context.session_id, text: JSON.stringify(ctx_usage), progress: 'ctx_usage' });
          }
        }
        break;
      }

      case 'stream_compact_start': {
        const { reply_context, compact_start } = event;
        if (reply_context.channel_type === 'tui') {
          const plugin = this.registry.getPlugin(reply_context.channel_id);
          if (plugin) {
            void plugin.send({ peer_id: reply_context.peer_id, session_id: reply_context.session_id, text: JSON.stringify(compact_start), progress: 'compact_start' });
          }
        }
        break;
      }

      case 'stream_compact_end': {
        const { reply_context, compact_end } = event;
        if (reply_context.channel_type === 'tui') {
          const plugin = this.registry.getPlugin(reply_context.channel_id);
          if (plugin) {
            void plugin.send({ peer_id: reply_context.peer_id, session_id: reply_context.session_id, text: JSON.stringify(compact_end), progress: 'compact_end' });
          }
        }
        break;
      }
    }
  }

  private flushTuiBuffer(state: SessionState): void {
    state.flushTimer = null;
    if (state.tokenBuffer.length === 0) return;
    const text = state.tokenBuffer.join('');
    state.tokenBuffer = [];
    const plugin = this.registry.getPlugin(state.channelId);
    if (!plugin) {
      this.logger.warn(`Dispatcher: no plugin for channel ${state.channelId}, discarding tui chunk`);
      return;
    }
    void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text, stream: 'chunk' });
  }
}
