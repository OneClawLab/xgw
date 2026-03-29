import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { parseMessageContent, parsePostContent } from '../../src/event-handler.js';

describe('message-parsing PBT', () => {
  // Feature: feishu-plugin, Property 1: Text content round-trip
  it('Property 1: Text content round-trip — Validates: Requirements 3.1', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (s) => {
        const wrapped = JSON.stringify({ text: s });
        return parseMessageContent(wrapped, 'text') === s;
      }),
    );
  });

  // Feature: feishu-plugin, Property 2: Post content text extraction
  it('Property 2: Post content text extraction — Validates: Requirements 3.2', () => {
    // Generate a post content with language key structure containing text nodes
    const postContentArb = fc
      .array(
        fc.array(
          fc.record({
            tag: fc.constant('text'),
            text: fc.string(),
          }),
          { minLength: 1 },
        ),
        { minLength: 1 },
      )
      .map((paragraphs) => JSON.stringify({ zh_cn: { content: paragraphs } }));

    fc.assert(
      fc.property(postContentArb, (contentStr) => {
        const parsed = JSON.parse(contentStr) as {
          zh_cn: { content: Array<Array<{ tag: string; text: string }>> };
        };
        const paragraphs = parsed.zh_cn.content;
        const result = parsePostContent(contentStr);

        // Every text node's .text value must appear in the output
        for (const paragraph of paragraphs) {
          for (const element of paragraph) {
            if (!result.includes(element.text)) {
              return false;
            }
          }
        }
        return true;
      }),
    );
  });

  // Feature: feishu-plugin, Property 3: Placeholder format for non-text types
  it('Property 3: Placeholder format for non-text types — Validates: Requirements 3.3, 3.4, 3.5', () => {
    // image: always returns '[image]'
    fc.assert(
      fc.property(fc.string(), (content) => {
        return parseMessageContent(content, 'image') === '[image]';
      }),
    );

    // file: returns '[file: <filename>]'
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).map((filename) => ({
          content: JSON.stringify({ file_name: filename }),
          filename,
        })),
        ({ content, filename }) => {
          return parseMessageContent(content, 'file') === `[file: ${filename}]`;
        },
      ),
    );

    // unsupported types: returns '[unsupported: <type>]'
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter((t) => !['text', 'post', 'image', 'file'].includes(t)),
        (type) => {
          return parseMessageContent('{}', type) === `[unsupported: ${type}]`;
        },
      ),
    );
  });

  // Feature: feishu-plugin, Property 4: Malformed JSON safety
  it('Property 4: Malformed JSON safety — Validates: Requirements 3.6', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        }),
        (s) => {
          let result: string;
          try {
            result = parseMessageContent(s, 'text');
          } catch {
            // Must not throw
            return false;
          }
          return result === '';
        },
      ),
    );
  });
});
