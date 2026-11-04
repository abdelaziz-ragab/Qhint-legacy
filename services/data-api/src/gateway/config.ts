import type { GatewayConfig } from './gateway';

/** Default routing: Haiku everywhere except ingest/assess (Sonnet); Sonnet is the escalation. */
export function defaultGatewayConfig(analyticsKey: string): GatewayConfig {
  const haiku = 'claude-haiku-5-5';
  const sonnet = 'claude-sonnet-5-5';
  return {
    models: {
      locate: { primary: haiku, escalation: sonnet },
      verify: { primary: haiku, escalation: sonnet },
      live: { primary: haiku, escalation: sonnet },
      assess: { primary: sonnet },
      ingest: { primary: sonnet },
    },
    // USD per million tokens (Anthropic list prices, Oct 2026). Used for cost metrics only.
    prices: {
      [haiku]: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      [sonnet]: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    },
    analyticsKey,
  };
}
