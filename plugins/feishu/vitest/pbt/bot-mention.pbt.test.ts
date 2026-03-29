import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import type { FeishuMessageEvent } from '../../src/index.js';
import { checkBotMentioned, stripBotMention } from '../../src/event-handler.js';

function makeEvent(
  mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>,
): FeishuMessageEvent {
  return {
    sender: { sender_id: {} },
    message: {
      message_id: 'msg1',
      chat_id: 'chat1',
      chat_type: 'group',
      message_type: 'text',
      content: '{}',
      mentions,
    },
  };
}

const mentionArb = fc.record({
  key: fc.string({ minLength: 1 }),
  id: fc.record({ open_id: fc.string({ minLength: 1 }) }),
  name: fc.string(),
});

describe('bot-mention PBT', () => {
  // Feature: feishu-plugin, Property 5: Bot mention detection correctness
  describe('Property 5: Bot mention detection correctness — Validates: Requirements 4.1, 4.2, 4.5', () => {
    // Case A: bot IS in mentions → must return true
    it('returns true when bot open_id is present in mentions', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(mentionArb),
          (botOpenId, otherMentions) => {
            const botMention = { key: '@_bot', id: { open_id: botOpenId }, name: 'bot' };
            const event = makeEvent([...otherMentions, botMention]);
            return checkBotMentioned(event, botOpenId) === true;
          },
        ),
      );
    });

    // Case B: bot is NOT in mentions → must return false
    it('returns false when bot open_id is absent from mentions', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(mentionArb),
          (botOpenId, mentions) => {
            // Filter out any mention that accidentally matches botOpenId
            const filteredMentions = mentions.filter((m) => m.id.open_id !== botOpenId);
            const event = makeEvent(filteredMentions);
            return checkBotMentioned(event, botOpenId) === false;
          },
        ),
      );
    });

    // Case C: botOpenId is undefined → always false
    it('returns false when botOpenId is undefined', () => {
      fc.assert(
        fc.property(fc.array(mentionArb), (mentions) => {
          const event = makeEvent(mentions);
          return checkBotMentioned(event, undefined) === false;
        }),
      );
    });
  });

  // Feature: feishu-plugin, Property 6: Bot mention stripping
  it('Property 6: Bot mention stripping — Validates: Requirements 4.4', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }), // botOpenId
        fc.string(),                  // prefix text
        fc.string(),                  // suffix text
        (botOpenId, prefix, suffix) => {
          const key = '@_user_1';
          const text = `${prefix}${key}${suffix}`;
          const mentions = [{ key, id: { open_id: botOpenId }, name: 'bot' }];
          const result = stripBotMention(text, mentions, botOpenId);
          // The mention key must be removed from the result
          return !result.includes(key);
        },
      ),
    );
  });
});
