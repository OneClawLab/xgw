import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import type { FeishuMessageEvent } from '../../src/index.js';
import { toMessage } from '../../src/event-handler.js';

describe('session-routing PBT', () => {
  // Feature: feishu-plugin, Property 7: Session ID routing
  it('Property 7: Session ID routing — Validates: Requirements 5.1, 5.2', () => {
    // p2p: session_id = sender open_id
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }), // openId
        fc.string({ minLength: 1 }), // chatId
        fc.string({ minLength: 1 }), // channelId
        (openId, chatId, channelId) => {
          const event: FeishuMessageEvent = {
            sender: { sender_id: { open_id: openId } },
            message: {
              message_id: 'msg1',
              chat_id: chatId,
              chat_type: 'p2p',
              message_type: 'text',
              content: JSON.stringify({ text: 'hello' }),
            },
          };
          const msg = toMessage(channelId, event);
          return msg.conversation_id === openId;
        },
      ),
    );

    // group: conversation_id = chat_id
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }), // openId
        fc.string({ minLength: 1 }), // chatId
        fc.string({ minLength: 1 }), // channelId
        (openId, chatId, channelId) => {
          const event: FeishuMessageEvent = {
            sender: { sender_id: { open_id: openId } },
            message: {
              message_id: 'msg1',
              chat_id: chatId,
              chat_type: 'group',
              message_type: 'text',
              content: JSON.stringify({ text: 'hello' }),
            },
          };
          const msg = toMessage(channelId, event);
          return msg.conversation_id === chatId;
        },
      ),
    );
  });
});
