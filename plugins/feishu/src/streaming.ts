interface StreamingSession {
  messageId: string | null;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  lastEditTime: number;
}

export interface StreamingBufferOptions {
  coalesceMs: number;
  sendMessage: (sessionId: string, text: string) => Promise<string>;
  editMessage: (messageId: string, text: string) => Promise<void>;
}

export class StreamingBuffer {
  private sessions = new Map<string, StreamingSession>();
  private readonly coalesceMs: number;
  private readonly sendMessage: (sessionId: string, text: string) => Promise<string>;
  private readonly editMessage: (messageId: string, text: string) => Promise<void>;

  constructor(options: StreamingBufferOptions) {
    this.coalesceMs = options.coalesceMs;
    this.sendMessage = options.sendMessage;
    this.editMessage = options.editMessage;
  }

  async handleChunk(sessionId: string, text: string): Promise<void> {
    let session = this.sessions.get(sessionId);

    if (session === undefined) {
      // First chunk: send placeholder and record messageId
      const messageId = await this.sendMessage(sessionId, '▍');
      session = {
        messageId,
        buffer: text,
        timer: null,
        lastEditTime: Date.now(),
      };
      this.sessions.set(sessionId, session);
      return;
    }

    // Subsequent chunks: update buffer to latest full text
    session.buffer = text;

    const now = Date.now();
    if (now - session.lastEditTime >= this.coalesceMs) {
      // Enough time has passed — edit immediately
      if (session.timer !== null) {
        clearTimeout(session.timer);
        session.timer = null;
      }
      await this.doEdit(session, sessionId);
    } else {
      // Too soon — set/reset coalesce timer
      if (session.timer !== null) {
        clearTimeout(session.timer);
      }
      session.timer = setTimeout(() => {
        session!.timer = null;
        void this.doEdit(session!, sessionId);
      }, this.coalesceMs);
    }
  }

  async handleEnd(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (session === undefined) {
      // No session yet — send as a plain message
      await this.sendMessage(sessionId, text);
      return;
    }

    // Clear any pending timer
    if (session.timer !== null) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    session.buffer = text;

    // Final edit with complete text
    await this.doEdit(session, sessionId);

    // Clean up session
    this.sessions.delete(sessionId);
  }

  clear(): void {
    for (const session of this.sessions.values()) {
      if (session.timer !== null) {
        clearTimeout(session.timer);
        session.timer = null;
      }
    }
    this.sessions.clear();
  }

  private async doEdit(session: StreamingSession, sessionId: string): Promise<void> {
    if (session.messageId === null) return;

    session.lastEditTime = Date.now();

    try {
      await this.editMessage(session.messageId, session.buffer);
    } catch (err) {
      console.error('[StreamingBuffer] editMessage failed, falling back to sendMessage:', err);
      try {
        const newMessageId = await this.sendMessage(sessionId, session.buffer);
        session.messageId = newMessageId;
      } catch (fallbackErr) {
        console.error('[StreamingBuffer] fallback sendMessage also failed:', fallbackErr);
      }
    }
  }
}
