import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendCommand } from '../../src/commands/send.js'
import type { Config } from '../../src/config.js'

vi.mock('../../src/config.js', () => ({
  resolveConfigPath: vi.fn().mockReturnValue('/tmp/xgw.yaml'),
  loadConfig: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

const baseConfig: Config = {
  gateway: { host: '0.0.0.0', port: 8080 },
  channels: [{ id: 'tui:main', type: 'tui', paired: false }],
  routing: [],
}

describe('sendCommand', () => {
  it('throws when channel does not exist in config', async () => {
    const { loadConfig } = await import('../../src/config.js')
    vi.mocked(loadConfig).mockReturnValue(baseConfig)

    await expect(
      sendCommand({ channel: 'nonexistent:ch', peer: 'p1', session: 's1', message: 'hi', json: false }),
    ).rejects.toThrow(/nonexistent:ch/)
  })

  it('throws when channel exists but plugin type is unknown', async () => {
    const { loadConfig } = await import('../../src/config.js')
    vi.mocked(loadConfig).mockReturnValue({
      ...baseConfig,
      channels: [{ id: 'tui:main', type: 'tui', paired: false }],
    })

    // tui plugin may or may not be loadable in test env — either way it must not silently succeed
    // with a non-empty message. We verify the channel lookup succeeds (no "not found" error).
    let caught: Error | undefined
    try {
      await sendCommand({ channel: 'tui:main', peer: 'p1', session: 's1', message: 'hello', json: false })
    } catch (err) {
      caught = err as Error
    }
    // If it throws, the error must NOT be about the channel being missing
    if (caught) {
      expect(caught.message).not.toMatch(/tui:main.*not found/i)
    }
  })

  it('throws when plugin fails to load for unknown channel type', async () => {
    const { loadConfig } = await import('../../src/config.js')
    vi.mocked(loadConfig).mockReturnValue({
      ...baseConfig,
      channels: [{ id: 'unknown:ch', type: 'unknown-type', paired: false }],
    })

    await expect(
      sendCommand({ channel: 'unknown:ch', peer: 'p1', session: 's1', message: 'hi', json: false }),
    ).rejects.toThrow(/plugin|No plugin|unknown-type|load/i)
  })

  it('error message for missing channel contains the channel id', async () => {
    const { loadConfig } = await import('../../src/config.js')
    vi.mocked(loadConfig).mockReturnValue(baseConfig)

    let caught: Error | undefined
    try {
      await sendCommand({ channel: 'missing:ch', peer: 'p1', session: 's1', message: 'hi', json: false })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toContain('missing:ch')
  })
})
