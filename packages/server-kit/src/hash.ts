import { createHmac } from 'node:crypto';

/**
 * Keyed hash of an identifier for operator analytics. Stable for the same key, so counts can be
 * grouped, but not reversible without the key (kept in Secret Manager).
 */
export function hashId(key: string, id: string): string {
  if (key.length < 32) throw new Error('analytics hash key must be at least 32 characters');
  return createHmac('sha256', key).update(id).digest('hex');
}
