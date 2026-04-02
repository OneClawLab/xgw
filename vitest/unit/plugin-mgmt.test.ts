import { describe, it, expect } from 'vitest'
import { pluginAdd, pluginRemove, pluginList } from '../../src/commands/plugin-mgmt.js'
import type { Config } from '../../src/config.js'

const baseConfig: Config = {
  gateway: { host: '0.0.0.0', port: 8080 },
  channels: [],
  routing: [],
}

describe('pluginAdd', () => {
  it('adds a new plugin type to config', () => {
    const result = pluginAdd(baseConfig, 'telegram', '@theclawlab/xgw-telegram')
    expect(result.plugins).toEqual({ telegram: '@theclawlab/xgw-telegram' })
  })

  it('preserves existing plugins when adding new one', () => {
    const config: Config = { ...baseConfig, plugins: { tui: '@theclawlab/xgw-tui' } }
    const result = pluginAdd(config, 'telegram', '@theclawlab/xgw-telegram')
    expect(result.plugins).toHaveProperty('tui')
    expect(result.plugins).toHaveProperty('telegram')
  })

  it('overwrites existing plugin type', () => {
    const config: Config = { ...baseConfig, plugins: { tui: 'old-package' } }
    const result = pluginAdd(config, 'tui', 'new-package')
    expect(result.plugins!['tui']).toBe('new-package')
  })

  it('does not mutate original config', () => {
    pluginAdd(baseConfig, 'tui', 'some-pkg')
    expect(baseConfig.plugins).toBeUndefined()
  })
})

describe('pluginRemove', () => {
  it('removes an existing plugin', () => {
    const config: Config = { ...baseConfig, plugins: { tui: '@theclawlab/xgw-tui', telegram: 'pkg' } }
    const result = pluginRemove(config, 'tui')
    expect(result.plugins).not.toHaveProperty('tui')
    expect(result.plugins).toHaveProperty('telegram')
  })

  it('throws when removing a plugin that does not exist', () => {
    expect(() => pluginRemove(baseConfig, 'nonexistent')).toThrow()
  })

  it('removes plugins key entirely when last plugin is removed', () => {
    const config: Config = { ...baseConfig, plugins: { tui: 'pkg' } }
    const result = pluginRemove(config, 'tui')
    expect(result.plugins).toBeUndefined()
  })
})

describe('pluginList', () => {
  it('returns empty array when no plugins configured', () => {
    expect(pluginList(baseConfig)).toEqual([])
  })

  it('returns empty array when plugins is undefined', () => {
    const config: Config = { ...baseConfig }
    expect(pluginList(config)).toEqual([])
  })

  it('lists all registered plugins', () => {
    const config: Config = {
      ...baseConfig,
      plugins: { tui: '@theclawlab/xgw-tui', telegram: '@theclawlab/xgw-telegram' },
    }
    const result = pluginList(config)
    expect(result).toHaveLength(2)
    expect(result.map(p => p.type)).toContain('tui')
    expect(result.map(p => p.type)).toContain('telegram')
    expect(result.find(p => p.type === 'tui')?.package).toBe('@theclawlab/xgw-tui')
  })
})
