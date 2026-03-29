import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { StreamingBuffer } from '../../src/streaming.js';

describe('streaming PBT', () => {
  // Feature: feishu-plugin, Property 8: Streaming buffer accumulation
  it('Property 8: Streaming buffer accumulation — Validates: Requirements 7.2', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 1, maxLength: 10 }), // sequence of chunk texts
        fc.string({ minLength: 1 }),                             // final text for handleEnd
        async (texts, finalText) => {
          const editCalls: Array<{ messageId: string; text: string }> = [];
          let msgIdCounter = 0;

          const buf = new StreamingBuffer({
            coalesceMs: 10000, // large so no coalesce timer fires during the test
            sendMessage: async (_sessionId, _text) => {
              return `msg-${++msgIdCounter}`;
            },
            editMessage: async (messageId, text) => {
              editCalls.push({ messageId, text });
            },
          });

          const sessionId = 'test-session';

          // Send all chunks — each text is the full accumulated text from the gateway
          for (const text of texts) {
            await buf.handleChunk(sessionId, text);
          }

          // Send end with the final complete text
          await buf.handleEnd(sessionId, finalText);

          // The last edit call should contain the final text
          const lastEdit = editCalls[editCalls.length - 1];
          return lastEdit !== undefined && lastEdit.text === finalText;
        },
      ),
    );
  });
});
