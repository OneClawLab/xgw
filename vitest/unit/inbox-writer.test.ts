import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../src/types.js';

// Mock execCommand before importing InboxWriter
vi.mock('../../src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

import { execCommand } from '../../src/repo-utils/os.js';
import { InboxWriter } from '../../src/inbox.js';

const mockExec = vi.mocked(execCommand);

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channel_id: 'telegram',
    peer_id: 'user42',
    peer_name: 'Alice',
    session_id: 'sess-1',
    text: 'Hello',
    attachments: [],
    reply_to: null,
    created_at: '2026-01-01T00:00:00.000Z',
    raw: { original: true },
    ...overrides,
  };
}

beforeEach(() => {
  mockExec.mockClear();
});

// ── InboxWriter.push ──────────────────────────────────────────────────────────

describe('InboxWriter.push', () => {
  it('calls thread push with correct args', async () => {
    const writer = new InboxWriter();
    const msg = makeMessage();
    const agents = { bot: { inbox: '/home/.theclaw/agents/bot/inbox' } };

    await writer.push('bot', msg, 'telegram', agents);

    expect(mockExec).toHaveBeenCalledOnce();
    expect(mockExec).toHaveBeenCalledWith('thread', expect.arrayContaining([
      'push',
      '--thread', '/home/.theclaw/agents/bot/inbox',
      '--source', 'external:telegram:telegram:dm:sess-1:user42',
      '--type', 'message',
    ]));
  });

  it('formats source as external:<channelType>:<channelId>:dm:<sessionId>:<peerId>', async () => {
    const writer = new InboxWriter();
    const msg = makeMessage({ channel_id: 'ch-99', session_id: 'sess-abc', peer_id: 'peer-xyz' });
    const agents = { bot: { inbox: '/inbox' } };

    await writer.push('bot', msg, 'slack', agents);

    const args = mockExec.mock.calls[0]![1] as string[];
    const sourceIdx = args.indexOf('--source');
    expect(args[sourceIdx + 1]).toBe('external:slack:ch-99:dm:sess-abc:peer-xyz');
  });

  it('serializes message content as JSON (excluding raw field)', async () => {
    const writer = new InboxWriter();
    const msg = makeMessage({ text: 'Test message', raw: { should: 'be excluded' } });
    const agents = { bot: { inbox: '/inbox' } };

    await writer.push('bot', msg, 'telegram', agents);

    const args = mockExec.mock.calls[0]![1] as string[];
    const contentIdx = args.indexOf('--content');
    const content = JSON.parse(args[contentIdx + 1]!);

    expect(content.text).toBe('Test message');
    expect(content.raw).toBeUndefined();
    expect(content.id).toBe('msg-1');
    expect(content.peer_id).toBe('user42');
  });

  it('throws when agent id is not in agents config', async () => {
    const writer = new InboxWriter();
    const msg = makeMessage();
    const agents = {};

    await expect(writer.push('ghost', msg, 'telegram', agents)).rejects.toThrow(/ghost/);
  });

  it('uses the correct inbox path from agents config', async () => {
    const writer = new InboxWriter();
    const msg = makeMessage();
    const agents = {
      alpha: { inbox: '/alpha/inbox' },
      beta: { inbox: '/beta/inbox' },
    };

    await writer.push('beta', msg, 'telegram', agents);

    const args = mockExec.mock.calls[0]![1] as string[];
    const threadIdx = args.indexOf('--thread');
    expect(args[threadIdx + 1]).toBe('/beta/inbox');
  });

  it('propagates execCommand errors', async () => {
    mockExec.mockRejectedValueOnce(new Error('thread not found'));
    const writer = new InboxWriter();
    const agents = { bot: { inbox: '/inbox' } };

    await expect(writer.push('bot', makeMessage(), 'telegram', agents)).rejects.toThrow('thread not found');
  });
});
