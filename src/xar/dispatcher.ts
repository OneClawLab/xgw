import type { Logger } from '../repo-utils/logger.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { XarOutboundEvent, SessionState } from './types.js';

const TUI_FLUSH_INTERVAL_MS = 100;
const STREAM_WATCHDOG_MS = 120_000; // warn if stream_end not received within 2 minutes

export class Dispatcher {
  private readonly registry: ChannelRegistry;
  private readonly logger: Logger;

  /** session_id → SessionState */
  private sessions = new Map<string, SessionState>();

  constructor(registry: ChannelRegistry, logger: Logger) {
    this.registry = registry;
    this.logger = logger;
  }

  private safeSend(plugin: NonNullable<ReturnType<ChannelRegistry['getPlugin']>>, params: Parameters<typeof plugin.send>[0], channelId: string): void {
    void plugin.send(params).catch((err: unknown) => {
      this.logger.error(`send failed: channel=${channelId} err=${err instanceof Error ? err.message : String(err)}`);
    });
  }

  handle(event: XarOutboundEvent): void {
    switch (event.type) {
      case 'stream_start': {
        const { session_id, reply_context } = event;
        const plugin = this.registry.getPlugin(reply_context.channel_id);
        const state: SessionState = {
          channelId: reply_context.channel_id,
          channelType: reply_context.channel_type,
          peerId: reply_context.peer_id,
          sessionId: session_id,
          streaming: plugin?.streaming === true,
          tokenBuffer: [],
          flushTimer: null,
          watchdogTimer: setTimeout(() => {
            this.logger.warn(`stream watchdog: no stream_end received for session=${session_id} channel=${reply_context.channel_id} after ${STREAM_WATCHDOG_MS}ms — possible xar/LLM hang`);
            this.sessions.delete(session_id);
          }, STREAM_WATCHDOG_MS),
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
        const plugin = this.registry.getPlugin(state.channelId);
        if (!plugin) {
          this.logger.warn(`Dispatcher: no plugin for channel ${state.channelId}, discarding stream_end`);
          this.sessions.delete(session_id);
          return;
        }
        if (state.watchdogTimer !== null) clearTimeout(state.watchdogTimer);
        const fullText = state.tokenBuffer.join('');
        this.logger.info(`stream_end: session=${session_id} channel=${state.channelId} peer=${state.peerId} chars=${fullText.length}`);

        if (state.channelType === 'tui') {
          // TUI: cancel pending timer, flush remaining tokens, then send stream_end
          if (state.flushTimer !== null) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
          }
          this.flushTuiBuffer(state);
          this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: '', stream: 'end' }, state.channelId);
        } else if (state.streaming) {
          // Streaming-capable plugin: send chunk (triggers placeholder + edit) then end
          this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: fullText, stream: 'chunk' }, state.channelId);
          this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: fullText, stream: 'end' }, state.channelId);
        } else {
          // Non-streaming: send as plain message
          this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: fullText }, state.channelId);
        }
        this.sessions.delete(session_id);
        break;
      }

      case 'stream_error': {
        const { session_id, error } = event;
        const state = this.sessions.get(session_id);
        if (state?.watchdogTimer !== null && state?.watchdogTimer !== undefined) {
          clearTimeout(state.watchdogTimer);
        }
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
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: delta, progress: 'thinking' }, state.channelId);
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
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(tool_call), progress: 'tool_call' }, state.channelId);
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
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(tool_result), progress: 'tool_result' }, state.channelId);
          }
        }
        break;
      }

      case 'stream_ctx_usage': {
        const { reply_context, ctx_usage } = event;
        if (reply_context.channel_type === 'tui') {
          const plugin = this.registry.getPlugin(reply_context.channel_id);
          if (plugin) {
            this.safeSend(plugin, { peer_id: reply_context.peer_id, session_id: reply_context.session_id, text: JSON.stringify(ctx_usage), progress: 'ctx_usage' }, reply_context.channel_id);
          }
        }
        break;
      }

      case 'stream_compact_start': {
        const { reply_context, compact_start } = event;
        if (reply_context.channel_type === 'tui') {
          const plugin = this.registry.getPlugin(reply_context.channel_id);
          if (plugin) {
            this.safeSend(plugin, { peer_id: reply_context.peer_id, session_id: reply_context.session_id, text: JSON.stringify(compact_start), progress: 'compact_start' }, reply_context.channel_id);
          }
        }
        break;
      }

      case 'stream_compact_end': {
        const { reply_context, compact_end } = event;
        if (reply_context.channel_type === 'tui') {
          const plugin = this.registry.getPlugin(reply_context.channel_id);
          if (plugin) {
            this.safeSend(plugin, { peer_id: reply_context.peer_id, session_id: reply_context.session_id, text: JSON.stringify(compact_end), progress: 'compact_end' }, reply_context.channel_id);
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
    void plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text, stream: 'chunk' }).catch((err: unknown) => {
      this.logger.error(`send failed: channel=${state.channelId} err=${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
