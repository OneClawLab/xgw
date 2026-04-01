import { randomUUID } from 'node:crypto';
import type { FeishuMessageEvent, Message } from './index.js';

/** Parse Feishu post rich text content to plain text.
 * Post content JSON can be either:
 *   { zh_cn: { title: '...', content: [[...], [...]] } }
 * or directly:
 *   { content: [[...], [...]] }
 * Each paragraph is an array of elements; only tag === 'text' elements are extracted.
 * Paragraphs are joined with '\n'.
 */
export function parsePostContent(contentStr: string): string {
  try {
    const parsed: unknown = JSON.parse(contentStr);
    if (typeof parsed !== 'object' || parsed === null) return '';

    // Resolve the object that has a `content` array
    let obj: unknown = parsed;

    // If no direct `content` key, look one level deeper (language key like zh_cn)
    if (!Object.prototype.hasOwnProperty.call(obj, 'content')) {
      const values = Object.values(parsed as Record<string, unknown>);
      if (values.length > 0) {
        obj = values[0];
      }
    }

    if (typeof obj !== 'object' || obj === null) return '';
    const record = obj as Record<string, unknown>;
    const content = record['content'];
    if (!Array.isArray(content)) return '';

    const paragraphs: string[] = [];
    for (const paragraph of content) {
      if (!Array.isArray(paragraph)) continue;
      const parts: string[] = [];
      for (const element of paragraph) {
        if (
          typeof element === 'object' &&
          element !== null &&
          (element as Record<string, unknown>)['tag'] === 'text'
        ) {
          const text = (element as Record<string, unknown>)['text'];
          if (typeof text === 'string') {
            parts.push(text);
          }
        }
      }
      paragraphs.push(parts.join(''));
    }

    return paragraphs.join('\n');
  } catch {
    return '';
  }
}

/** Parse Feishu message content string to plain text.
 * Never throws — returns '' on any error.
 */
export function parseMessageContent(content: string, messageType: string): string {
  try {
    switch (messageType) {
      case 'text': {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return typeof parsed['text'] === 'string' ? parsed['text'] : '';
      }
      case 'post': {
        return parsePostContent(content);
      }
      case 'image': {
        return '[image]';
      }
      case 'file': {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const fileName = typeof parsed['file_name'] === 'string' ? parsed['file_name'] : '';
        return `[file: ${fileName}]`;
      }
      default: {
        return `[unsupported: ${messageType}]`;
      }
    }
  } catch {
    return '';
  }
}

/** Check whether the event mentions the bot (by open_id). */
export function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  if (!botOpenId) return false;
  const mentions = event.message.mentions;
  if (!mentions || mentions.length === 0) return false;
  return mentions.some((m) => m.id.open_id === botOpenId);
}

/** Strip the bot's @mention placeholder from the text. */
export function stripBotMention(
  text: string,
  mentions: FeishuMessageEvent['message']['mentions'],
  botOpenId?: string,
): string {
  if (!botOpenId || !mentions) return text;
  const botMention = mentions.find((m) => m.id.open_id === botOpenId);
  if (!botMention) return text;
  return text.replace(botMention.key, '').trim();
}

/** Convert a FeishuMessageEvent to an xgw Message. */
export function toMessage(
  channelId: string,
  event: FeishuMessageEvent,
  botOpenId?: string,
): Message {
  const rawText = parseMessageContent(event.message.content, event.message.message_type);
  const text = stripBotMention(rawText, event.message.mentions, botOpenId);

  const conversationId =
    event.message.chat_type === 'p2p'
      ? (event.sender.sender_id.open_id ?? '')
      : event.message.chat_id;

  return {
    id: randomUUID(),
    channel_id: channelId,
    peer_id: event.sender.sender_id.open_id ?? '',
    peer_name: event.sender.sender_id.open_id ?? null,
    conversation_id: conversationId,
    text,
    attachments: [],
    reply_to: event.message.parent_id ?? null,
    created_at: new Date().toISOString(),
    raw: event as object,
  };
}
