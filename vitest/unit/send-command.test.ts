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

  it('throws when no message provided and stdin is empty', async () => {
    const { loadConfig } = await import('../../src/config.js')
    vi.mocked(loadConfig).mockReturnValue(baseConfig)

    // Mock readFileSync(0) to return empty string
    vi.doMock('node:fs', () => ({
      readFileSync: (fd: unknown) => fd === 0 ? '' : '',
    }))

    const { sendCommand: freshSend } = await import('../../src/commands/send.js')
    await expect(
      freshSend({ channel: 'tui:main', peer: 'p1', session: 's1', json: false }),
    ).rejects.toThrow(/No message/)
    vi.resetModules()
  })

  it('throws when plugin fails to load for channel type', async () => {
    const { loadConfig } = await import('../../src/config.js')
    vi.mocked(loadConfig).mockReturnValue({
      ...baseConfig,
      channels: [{ id: 'unknown:ch', type: 'unknown-type', paired: false }],
    })

    await expect(
      sendCommand({ channel: 'unknown:ch', peer: 'p1', session: 's1', message: 'hi', json: false }),
    ).rejects.toThrow(/plugin|No plugin/)
  })
})
