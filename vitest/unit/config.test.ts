/**
 * Unit tests for parseXarConfig (src/config.ts)
 * Validates: Requirements 5.5, 5.6
 *
 * PBT tests for config path resolution, validation, and YAML round-trip
 * live in vitest/pbt/config.pbt.test.ts
 */

import { describe, it, expect } from 'vitest';
import { parseXarConfig } from '../../src/config.js';

describe('parseXarConfig: complete xar config parsing', () => {
  it('parses a fully specified xar config', () => {
    const raw = { port: 9000, reconnect_interval_ms: 1000 };
    const result = parseXarConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(9000);
    expect(result.value.reconnect_interval_ms).toBe(1000);
  });

  it('fills default port when omitted', () => {
    const result = parseXarConfig({ reconnect_interval_ms: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(29211);
  });

  it('fills default reconnect_interval_ms when omitted', () => {
    const result = parseXarConfig({ port: 9000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reconnect_interval_ms).toBe(3000);
  });

  it('returns all defaults when given an empty object', () => {
    const result = parseXarConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(29211);
    expect(result.value.reconnect_interval_ms).toBe(3000);
  });

  it('returns all defaults when given null', () => {
    const result = parseXarConfig(null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(29211);
    expect(result.value.reconnect_interval_ms).toBe(3000);
  });
});

describe('parseXarConfig: format errors return descriptive messages', () => {
  it('returns error when xar is an array', () => {
    const result = parseXarConfig([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar must be an object/i);
  });

  it('returns error when xar is a string', () => {
    const result = parseXarConfig('bad');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar must be an object/i);
  });

  it('returns error when port is a string', () => {
    const result = parseXarConfig({ port: 'not-a-port' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar\.port/i);
  });

  it('returns error when port is 0', () => {
    const result = parseXarConfig({ port: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar\.port/i);
  });

  it('returns error when port exceeds 65535', () => {
    const result = parseXarConfig({ port: 70000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar\.port/i);
  });

  it('returns error when port is a float', () => {
    const result = parseXarConfig({ port: 8080.5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar\.port/i);
  });

  it('returns error when reconnect_interval_ms is zero', () => {
    const result = parseXarConfig({ reconnect_interval_ms: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar\.reconnect_interval_ms/i);
  });

  it('returns error when reconnect_interval_ms is negative', () => {
    const result = parseXarConfig({ reconnect_interval_ms: -100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar\.reconnect_interval_ms/i);
  });

  it('returns error when reconnect_interval_ms is a string', () => {
    const result = parseXarConfig({ reconnect_interval_ms: 'fast' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/xar\.reconnect_interval_ms/i);
  });

  it('error message is actionable (length > 10)', () => {
    const result = parseXarConfig({ port: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(10);
  });
});
