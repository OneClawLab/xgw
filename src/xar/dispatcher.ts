import type { Logger } from '../repo-utils/logger.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { XarOutboundEvent, StreamState } from './types.js';

const TUI_FLUSH_INTERVAL_MS = 100;
const STREAM_WATCHDOG_MS = 600_000; // warn if stream_end not received within 10 minutes
/** Suppress repeated send errors for the same channel; log a summary every N ms. */
const SEND_ERROR_SUPPRESS_MS = 5_000;

/**
 * Extract channel type from channel_id (format: "<type>:<instance>").
 */
function channelType(channelId: string): string {
  const idx = channelId.indexOf(':');
  return idx >= 0 ? channelId.slice(0, idx) : channelId;
}

export class Dispatcher {
  private readonly registry: ChannelRegistry;
  private readonly logger: Logger;

  /** stream_id → StreamState */
  private streams = new Map<string, StreamState>();

  /** Pre-stream event buffer: events that arrive before stream_start */
  private preStreamBuffer = new Map<string, XarOutboundEvent[]>();

  /** channel_id → { count, timer, lastMsg } for error rate-limiting */
  private sendErrorState = new Map<string, { count: number; timer: ReturnType<typeof setTimeout>; lastMsg: string }>();

  constructor(registry: ChannelRegistry, logger: Logger) {
    this.registry = registry;
    this.logger = logger;
  }

  private safeSend(plugin: NonNullable<ReturnType<ChannelRegistry['getPlugin']>>, params: Parameters<typeof plugin.send>[0], chId: string): void {
    void plugin.send(params).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const existing = this.sendErrorState.get(chId);
      if (!existing) {
        this.logger.error(`send failed: channel=${chId} err=${msg}`);
        const timer = setTimeout(() => {
          const state = this.sendErrorState.get(chId);
          if (state && state.count > 1) {
            this.logger.error(`send failed: channel=${chId} (${state.count - 1} more suppressed, last: ${state.lastMsg})`);
          }
          this.sendErrorState.delete(chId);
        }, SEND_ERROR_SUPPRESS_MS);
        this.sendErrorState.set(chId, { count: 1, timer, lastMsg: msg });
      } else {
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
        const { stream_id, target } = event;
        const plugin = this.registry.getPlugin(target.channel_id);
        const chType = channelType(target.channel_id);
        const state: StreamState = {
          channelId: target.channel_id,
          peerId: target.peer_id,
          conversationId: target.conversation_id,
          streaming: plugin?.streaming === true,
          tokenBuffer: [],
          flushTimer: null,
          watchdogTimer: setTimeout(() => {
            this.logger.warn(`stream watchdog: no stream_end received for stream=${stream_id} channel=${target.channel_id} after ${STREAM_WATCHDOG_MS}ms — possible xar/LLM hang`);
          }, STREAM_WATCHDOG_MS),
        };
        this.streams.set(stream_id, state);
        this.logger.info(`stream_start: stream=${stream_id} channel=${target.channel_id} peer=${target.peer_id}`);

        // Replay any events that arrived before stream_start
        const buffered = this.preStreamBuffer.get(stream_id);
        if (buffered) {
          this.preStreamBuffer.delete(stream_id);
          for (const e of buffered) {
            await this._handle(e);
          }
        }
        break;
      }

      case 'stream_token': {
        const { stream_id, token } = event;
        const state = this.streams.get(stream_id);
        if (!state) {
          const key = `unknown:${stream_id}`;
          const existing = this.sendErrorState.get(key);
          if (!existing) {
            this.logger.warn(`Dispatcher: stream_token for unknown stream ${stream_id}, discarding`);
            const timer = setTimeout(() => {
              const s = this.sendErrorState.get(key);
              if (s && s.count > 1) {
                this.logger.warn(`Dispatcher: stream_token for unknown stream ${stream_id} (${s.count - 1} more suppressed)`);
              }
              this.sendErrorState.delete(key);
            }, SEND_ERROR_SUPPRESS_MS);
            this.sendErrorState.set(key, { count: 1, timer, lastMsg: stream_id });
          } else {
            existing.count += 1;
          }
          return;
        }
        state.tokenBuffer.push(token);
        const chType = channelType(state.channelId);
        if (chType === 'tui') {
          if (state.flushTimer === null) {
            state.flushTimer = setTimeout(() => {
              this.flushTuiBuffer(state);
            }, TUI_FLUSH_INTERVAL_MS);
          }
        } else if (state.streaming) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            const accumulatedText = state.tokenBuffer.join('');
            this.safeSend(plugin, { peer_id: state.peerId, conversation_id: state.conversationId, text: accumulatedText, stream: 'chunk' }, state.channelId);
          }
        }
        break;
      }

      case 'stream_end': {
        const { stream_id } = event;
        const state = this.streams.get(stream_id);
        if (!state) {
          this.logger.warn(`Dispatcher: stream_end for unknown stream ${stream_id}, discarding`);
          return;
        }
        const plugin = this.registry.getPlugin(state.channelId);
        if (!plugin) {
          this.logger.warn(`Dispatcher: no plugin for channel ${state.channelId}, discarding stream_end`);
          this.streams.delete(stream_id);
          return;
        }
        if (state.watchdogTimer !== null) clearTimeout(state.watchdogTimer);
        const fullText = state.tokenBuffer.join('');
        this.logger.info(`stream_end: stream=${stream_id} channel=${state.channelId} peer=${state.peerId} chars=${fullText.length}`);

        if (state.pendingProgress) {
          await state.pendingProgress;
        }

        const chType = channelType(state.channelId);
        if (chType === 'tui') {
          if (state.flushTimer !== null) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
          }
          this.flushTuiBuffer(state);
          this.safeSend(plugin, { peer_id: state.peerId, conversation_id: state.conversationId, text: '', stream: 'end' }, state.channelId);
        } else if (state.streaming) {
          this.safeSend(plugin, { peer_id: state.peerId, conversation_id: state.conversationId, text: fullText, stream: 'end' }, state.channelId);
        } else {
          this.safeSend(plugin, { peer_id: state.peerId, conversation_id: state.conversationId, text: fullText }, state.channelId);
        }
        this.streams.delete(stream_id);
        break;
      }

      case 'stream_error': {
        const { stream_id, error } = event;
        const state = this.streams.get(stream_id);
        if (state?.watchdogTimer !== null && state?.watchdogTimer !== undefined) {
          clearTimeout(state.watchdogTimer);
        }
        if (state?.flushTimer !== null && state?.flushTimer !== undefined) {
          clearTimeout(state.flushTimer);
        }
        this.logger.error(`Dispatcher: stream_error for stream ${stream_id}: ${error}`);
        if (state) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            this.safeSend(plugin, { peer_id: state.peerId, conversation_id: state.conversationId, text: `Error: ${error}` }, state.channelId);
          }
        }
        this.streams.delete(stream_id);
        break;
      }

      case 'stream_thinking': {
        const state = this.streams.get(event.stream_id);
        if (!state) return;
        this.sendProgressIfStreaming(state, event.delta, 'thinking');
        break;
      }

      case 'stream_tool_call': {
        const state = this.streams.get(event.stream_id);
        if (!state) return;
        this.sendProgressIfStreaming(state, JSON.stringify(event.tool_call), 'tool_call');
        break;
      }

      case 'stream_tool_result': {
        const { stream_id, tool_result } = event;
        const state = this.streams.get(stream_id);
        if (!state) return;
        if (state.streaming) {
          const plugin = this.registry.getPlugin(state.channelId);
          if (plugin) {
            const p = plugin.send({ peer_id: state.peerId, conversation_id: state.conversationId, text: JSON.stringify(tool_result), progress: 'tool_result' })
              .catch((err: unknown) => {
                this.logger.error(`send failed: channel=${state.channelId} err=${err instanceof Error ? err.message : String(err)}`);
              });
            state.pendingProgress = (state.pendingProgress ?? Promise.resolve()).then(() => p);
          }
        }
        break;
      }

      case 'stream_ctx_usage':
        this.handleBufferedProgressEvent(event.stream_id, event, JSON.stringify(event.ctx_usage), 'ctx_usage');
        break;

      case 'stream_compact_start':
        this.handleBufferedProgressEvent(event.stream_id, event, JSON.stringify(event.compact_start), 'compact_start');
        break;

      case 'stream_compact_end':
        this.handleBufferedProgressEvent(event.stream_id, event, JSON.stringify(event.compact_end), 'compact_end');
        break;
    }
  }

  /** Send a progress event to the plugin if the stream is in streaming mode. */
  private sendProgressIfStreaming(state: StreamState, text: string, progress: NonNullable<import('../types.js').SendParams['progress']>): void {
    if (!state.streaming) return;
    const plugin = this.registry.getPlugin(state.channelId);
    if (plugin) {
      this.safeSend(plugin, { peer_id: state.peerId, conversation_id: state.conversationId, text, progress }, state.channelId);
    }
  }

  /**
   * Handle a progress event that may arrive before stream_start.
   * Buffers the event if the stream is not yet known; otherwise delegates to sendProgressIfStreaming.
   */
  private handleBufferedProgressEvent(
    streamId: string,
    event: XarOutboundEvent,
    text: string,
    progress: NonNullable<import('../types.js').SendParams['progress']>,
  ): void {
    const state = this.streams.get(streamId);
    if (!state) {
      const buf = this.preStreamBuffer.get(streamId) ?? [];
      buf.push(event);
      this.preStreamBuffer.set(streamId, buf);
      return;
    }
    this.sendProgressIfStreaming(state, text, progress);
  }

  private flushTuiBuffer(state: StreamState): void {
    state.flushTimer = null;
    if (state.tokenBuffer.length === 0) return;
    const text = state.tokenBuffer.join('');
    state.tokenBuffer = [];
    const plugin = this.registry.getPlugin(state.channelId);
    if (!plugin) {
      this.logger.warn(`Dispatcher: no plugin for channel ${state.channelId}, discarding tui chunk`);
      return;
    }
    void plugin.send({ peer_id: state.peerId, conversation_id: state.conversationId, text, stream: 'chunk' }).catch((err: unknown) => {
      this.logger.error(`send failed: channel=${state.channelId} err=${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
