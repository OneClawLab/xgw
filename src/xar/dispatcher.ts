import type { Logger } from '../repo-utils/logger.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { XarOutboundEvent, SessionState } from './types.js';

const TUI_FLUSH_INTERVAL_MS = 100;
const STREAM_WATCHDOG_MS = 600_000; // warn if stream_end not received within 10 minutes
/** Suppress repeated send errors for the same channel; log a summary every N ms. */
const SEND_ERROR_SUPPRESS_MS = 5_000;

export class Dispatcher {
  private readonly registry: ChannelRegistry;
  private readonly logger: Logger;

  /** session_id → SessionState */
  private sessions = new Map<string, SessionState>();

  /** Pre-session event buffer: events that arrive before stream_start */
  private preSessionBuffer = new Map<string, XarOutboundEvent[]>();

  /** channel_id → { count, timer, lastMsg } for error rate-limiting */
  private sendErrorState = new Map<string, { count: number; timer: ReturnType<typeof setTimeout>; lastMsg: string }>();

  constructor(registry: ChannelRegistry, logger: Logger) {
    this.registry = registry;
    this.logger = logger;
  }

  private safeSend(plugin: NonNullable<ReturnType<ChannelRegistry['getPlugin']>>, params: Parameters<typeof plugin.send>[0], channelId: string): void {
    void plugin.send(params).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const existing = this.sendErrorState.get(channelId);
      if (!existing) {
        // First error — log immediately and start suppression window
        this.logger.error(`send failed: channel=${channelId} err=${msg}`);
        const timer = setTimeout(() => {
          const state = this.sendErrorState.get(channelId);
          if (state && state.count > 1) {
            this.logger.error(`send failed: channel=${channelId} (${state.count - 1} more suppressed, last: ${state.lastMsg})`);
          }
          this.sendErrorState.delete(channelId);
        }, SEND_ERROR_SUPPRESS_MS);
        this.sendErrorState.set(channelId, { count: 1, timer, lastMsg: msg });
      } else {
        // Subsequent errors within window — suppress, just count
        existing.count += 1;
        existing.lastMsg = msg;
      }
    });
  }

  handle(event: XarOutboundEvent): void {
    void this._handle(event);
  }

  private async _handle(event: XarOutboundEvent): Promise<void> {
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
            // Only warn — do NOT delete the session. The LLM may still be
            // running (slow model, long context). Deleting here would cause
            // all subsequent tokens to be discarded and the response lost.
            this.logger.warn(`stream watchdog: no stream_end received for session=${session_id} channel=${reply_context.channel_id} after ${STREAM_WATCHDOG_MS}ms — possible xar/LLM hang`);
          }, STREAM_WATCHDOG_MS),
        };
        this.sessions.set(session_id, state);
        this.logger.info(`stream_start: session=${session_id} channel=${reply_context.channel_id} peer=${reply_context.peer_id}`);

        // Replay any events that arrived before stream_start
        const buffered = this.preSessionBuffer.get(session_id);
        if (buffered) {
          this.preSessionBuffer.delete(session_id);
          for (const e of buffered) {
            await this._handle(e);
          }
        }
        break;
      }

      case 'stream_token': {
        const { session_id, token } = event;
        const state = this.sessions.get(session_id);
        if (!state) {
          // Rate-limit repeated "unknown session" warnings (e.g. post-watchdog tokens)
          const key = `unknown:${session_id}`;
          const existing = this.sendErrorState.get(key);
          if (!existing) {
            this.logger.warn(`Dispatcher: stream_token for unknown session ${session_id}, discarding`);
            const timer = setTimeout(() => {
              const s = this.sendErrorState.get(key);
              if (s && s.count > 1) {
                this.logger.warn(`Dispatcher: stream_token for unknown session ${session_id} (${s.count - 1} more suppressed)`);
              }
              this.sendErrorState.delete(key);
            }, SEND_ERROR_SUPPRESS_MS);
            this.sendErrorState.set(key, { count: 1, timer, lastMsg: session_id });
          } else {
            existing.count += 1;
          }
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
        } else if (state.streaming) {
          // Streaming plugin: forward accumulated text as chunk in real-time
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            const accumulatedText = state.tokenBuffer.join('');
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: accumulatedText, stream: 'chunk' }, state.channelId);
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

        // Wait for any in-flight progress sends (e.g. tool_result) before finalizing
        if (state.pendingProgress) {
          await state.pendingProgress;
        }

        if (state.channelType === 'tui') {
          // TUI: cancel pending timer, flush remaining tokens, then send stream_end
          if (state.flushTimer !== null) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
          }
          this.flushTuiBuffer(state);
          this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: '', stream: 'end' }, state.channelId);
        } else if (state.streaming) {
          // Streaming plugin: tokens were already forwarded in real-time via stream_token.
          // Just send stream_end with the complete text for final flush.
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

        // Forward error to client so they don't hang
        if (state) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: `Error: ${error}` }, state.channelId);
          }
        }
        this.sessions.delete(session_id);
        break;
      }

      case 'stream_thinking': {
        const { session_id, delta } = event;
        const state = this.sessions.get(session_id);
        if (!state) return;
        if (state.streaming) {
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
        if (state.streaming) {
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
        if (state.streaming) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            // Use safeSend but track the promise so stream_end can wait for it
            const p = plugin.send({ peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(tool_result), progress: 'tool_result' })
              .catch((err: unknown) => {
                this.logger.error(`send failed: channel=${state.channelId} err=${err instanceof Error ? err.message : String(err)}`);
              });
            state.pendingProgress = (state.pendingProgress ?? Promise.resolve()).then(() => p);
          }
        }
        break;
      }

      case 'stream_ctx_usage': {
        const { session_id, ctx_usage } = event;
        const state = this.sessions.get(session_id);
        if (!state) {
          // Buffer — may arrive before stream_start
          const buf = this.preSessionBuffer.get(session_id) ?? [];
          buf.push(event);
          this.preSessionBuffer.set(session_id, buf);
          break;
        }
        if (state.streaming) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(ctx_usage), progress: 'ctx_usage' }, state.channelId);
          }
        }
        break;
      }

      case 'stream_compact_start': {
        const { session_id, compact_start } = event;
        const state = this.sessions.get(session_id);
        if (!state) {
          const buf = this.preSessionBuffer.get(session_id) ?? [];
          buf.push(event);
          this.preSessionBuffer.set(session_id, buf);
          break;
        }
        if (state.streaming) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(compact_start), progress: 'compact_start' }, state.channelId);
          }
        }
        break;
      }

      case 'stream_compact_end': {
        const { session_id, compact_end } = event;
        const state = this.sessions.get(session_id);
        if (!state) {
          const buf = this.preSessionBuffer.get(session_id) ?? [];
          buf.push(event);
          this.preSessionBuffer.set(session_id, buf);
          break;
        }
        if (state.streaming) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            this.safeSend(plugin, { peer_id: state.peerId, session_id: state.sessionId, text: JSON.stringify(compact_end), progress: 'compact_end' }, state.channelId);
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
