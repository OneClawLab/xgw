/**
 * Unit tests for xgw Router (src/gateway/router.ts)
 */

import { describe, it, expect } from 'vitest'
import { Router } from '../../src/gateway/router.js'

describe('Router', () => {
  it('returns null when no rules configured', () => {
    const router = new Router()
    expect(router.resolve('tui:default', 'alice')).toBeNull()
  })

  it('resolves wildcard peer match', () => {
    const router = new Router([
      { channel: 'tui:default', peer: '*', agent: 'admin' },
    ])
    expect(router.resolve('tui:default', 'alice')).toBe('admin')
    expect(router.resolve('tui:default', 'bob')).toBe('admin')
  })

  it('resolves exact peer match', () => {
    const router = new Router([
      { channel: 'telegram:main', peer: 'alice', agent: 'support' },
    ])
    expect(router.resolve('telegram:main', 'alice')).toBe('support')
    expect(router.resolve('telegram:main', 'bob')).toBeNull()
  })

  it('exact match takes priority over wildcard', () => {
    const router = new Router([
      { channel: 'telegram:main', peer: '*', agent: 'admin' },
      { channel: 'telegram:main', peer: 'alice', agent: 'vip' },
    ])
    expect(router.resolve('telegram:main', 'alice')).toBe('vip')
    expect(router.resolve('telegram:main', 'bob')).toBe('admin')
  })

  it('returns null for unmatched channel', () => {
    const router = new Router([
      { channel: 'tui:default', peer: '*', agent: 'admin' },
    ])
    expect(router.resolve('telegram:main', 'alice')).toBeNull()
  })

  it('handles multiple channels independently', () => {
    const router = new Router([
      { channel: 'tui:default', peer: '*', agent: 'admin' },
      { channel: 'telegram:main', peer: '*', agent: 'support' },
    ])
    expect(router.resolve('tui:default', 'alice')).toBe('admin')
    expect(router.resolve('telegram:main', 'alice')).toBe('support')
  })

  it('reload replaces all rules', () => {
    const router = new Router([
      { channel: 'tui:default', peer: '*', agent: 'admin' },
    ])
    expect(router.resolve('tui:default', 'alice')).toBe('admin')

    router.reload([
      { channel: 'telegram:main', peer: '*', agent: 'support' },
    ])
    expect(router.resolve('tui:default', 'alice')).toBeNull()
    expect(router.resolve('telegram:main', 'alice')).toBe('support')
  })

  it('first wildcard match wins when multiple wildcards exist', () => {
    const router = new Router([
      { channel: 'tui:default', peer: '*', agent: 'first' },
      { channel: 'tui:default', peer: '*', agent: 'second' },
    ])
    expect(router.resolve('tui:default', 'anyone')).toBe('first')
  })
})
