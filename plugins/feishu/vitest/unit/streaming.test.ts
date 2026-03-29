import { describe, it, expect, vi } from 'vitest';
import { StreamingBuffer } from '../../src/streaming.js';

describe('StreamingBuffer unit tests', () => {
  it('first chunk sends placeholder message (Req 7.1)', async () => {
    const sendMessage = vi.fn().mockResolvedValue('msg-1');
    const editMessage = vi.fn().mockResolvedValue(undefined);

    const buf = new StreamingBuffer({ coalesceMs: 10000, sendMessage, editMessage });
    await buf.handleChunk('session1', 'hello world');

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith('session1', '▍');
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('handleEnd performs final edit and clears session (Req 7.3)', async () => {
    const sendMessage = vi.fn().mockResolvedValue('msg-1');
    const editMessage = vi.fn().mockResolvedValue(undefined);

    const buf = new StreamingBuffer({ coalesceMs: 10000, sendMessage, editMessage });
    await buf.handleChunk('session1', 'partial text');
    await buf.handleEnd('session1', 'final text');

    // editMessage should have been called with final text
    expect(editMessage).toHaveBeenCalledWith('msg-1', 'final text');

    // After end, session is cleared — next handleEnd on same session calls sendMessage
    const sendMessage2 = vi.fn().mockResolvedValue('msg-2');
    const editMessage2 = vi.fn().mockResolvedValue(undefined);
    const buf2 = new StreamingBuffer({ coalesceMs: 10000, sendMessage: sendMessage2, editMessage: editMessage2 });
    await buf2.handleEnd('session1', 'orphan text');
    expect(sendMessage2).toHaveBeenCalledWith('session1', 'orphan text');
    expect(editMessage2).not.toHaveBeenCalled();
  });

  it('edit failure falls back to sendMessage (Req 7.5)', async () => {
    let callCount = 0;
    const sendMessage = vi.fn().mockImplementation(async () => `msg-${++callCount}`);
    const editMessage = vi.fn().mockRejectedValue(new Error('API error'));

    const buf = new StreamingBuffer({ coalesceMs: 0, sendMessage, editMessage });
    await buf.handleChunk('session1', 'first');
    // Second chunk with coalesceMs=0 triggers immediate edit → fails → fallback sendMessage
    await buf.handleChunk('session1', 'second');

    expect(editMessage).toHaveBeenCalled();
    // sendMessage called at least twice: once for placeholder, once for fallback
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('coalesceMs=0 triggers immediate edit on subsequent chunks (Req 7.4)', async () => {
    const sendMessage = vi.fn().mockResolvedValue('msg-1');
    const editMessage = vi.fn().mockResolvedValue(undefined);

    const buf = new StreamingBuffer({ coalesceMs: 0, sendMessage, editMessage });
    await buf.handleChunk('session1', 'first');   // sends placeholder
    await buf.handleChunk('session1', 'second');  // coalesceMs=0 → immediate edit

    expect(editMessage).toHaveBeenCalledWith('msg-1', 'second');
  });
});
