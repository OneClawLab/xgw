import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import yaml from 'js-yaml';
import { parseXarConfig } from '../../src/config.js';
import type { XarConfig } from '../../src/xar/types.js';

// ── Generators ────────────────────────────────────────────────────────────────

/** Valid TCP port: integer 1–65535 */
const genPort = () => fc.integer({ min: 1, max: 65535 });

/** Valid reconnect interval: positive integer */
const genReconnectMs = () => fc.integer({ min: 1, max: 300000 });

/** Partial raw xar config object — any combination of fields may be absent */
const genPartialRawXar = () =>
  fc.record(
    {
      port: genPort(),
      reconnect_interval_ms: genReconnectMs(),
    },
    { requiredKeys: [] }, // all fields optional
  );

/** Full valid XarConfig object (all fields present) */
const genFullXarConfig = (): fc.Arbitrary<XarConfig> =>
  fc.record({
    port: genPort(),
    reconnect_interval_ms: genReconnectMs(),
  });

// ── Property 8: XarConfig 默认值正确性 ───────────────────────────────────────
describe('Property 8: XarConfig 默认值正确性', () => {
  it('省略的字段在 parseXarConfig() 后填充正确默认值', () => {
    fc.assert(
      fc.property(genPartialRawXar(), (raw) => {
        const result = parseXarConfig(raw);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const cfg = result.value;

        // Missing port → default 18792
        if (!('port' in raw)) {
          expect(cfg.port).toBe(18792);
        } else {
          expect(cfg.port).toBe(raw.port);
        }

        // Missing reconnect_interval_ms → default 3000
        if (!('reconnect_interval_ms' in raw)) {
          expect(cfg.reconnect_interval_ms).toBe(3000);
        } else {
          expect(cfg.reconnect_interval_ms).toBe(raw.reconnect_interval_ms);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('完全省略 xar 节（null）时所有字段均为默认值', () => {
    const result = parseXarConfig(null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(18792);
    expect(result.value.reconnect_interval_ms).toBe(3000);
  });
});

// ── Property 9: XarConfig YAML 解析往返一致性 ────────────────────────────────
describe('Property 9: XarConfig YAML 解析往返一致性', () => {
  it('任意合法 XarConfig 经 YAML 序列化再解析后字段完全等价', () => {
    fc.assert(
      fc.property(genFullXarConfig(), (original) => {
        const yamlStr = yaml.dump(original, { lineWidth: -1, noRefs: true });
        const rawParsed = yaml.load(yamlStr);

        const result = parseXarConfig(rawParsed);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const roundtripped = result.value;
        expect(roundtripped.port).toBe(original.port);
        expect(roundtripped.reconnect_interval_ms).toBe(original.reconnect_interval_ms);
      }),
      { numRuns: 100 },
    );
  });
});
