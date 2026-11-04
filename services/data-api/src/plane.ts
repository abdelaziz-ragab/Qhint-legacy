import type { InternalCaller } from '@qhint/server-kit';
import { z } from 'zod';

const Location = z.object({
  tenantId: z.string(),
  firebaseTenantId: z.string(),
  endpoint: z.string(),
  bucket: z.string(),
  keyRef: z.string(),
  region: z.string(),
});
export type DataPlaneLocation = z.infer<typeof Location>;

export interface DataPlaneResolver {
  resolve(tenantId: string): Promise<DataPlaneLocation | null>;
}

/**
 * Asks control-api where a tenant's data plane lives (data-api never reads control tables).
 * Cached briefly; misses are cached too so unknown tenants can't hammer control-api.
 */
export class HttpDataPlaneResolver implements DataPlaneResolver {
  private readonly cache = new Map<string, { value: DataPlaneLocation | null; until: number }>();

  constructor(
    private readonly controlApiUrl: string,
    private readonly caller: InternalCaller,
    private readonly ttlMs = 60_000,
  ) {}

  async resolve(tenantId: string): Promise<DataPlaneLocation | null> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.until > Date.now()) return hit.value;

    const url = `${this.controlApiUrl}/internal/data-planes/${encodeURIComponent(tenantId)}`;
    const res = await fetch(url, { headers: await this.caller.headers(this.controlApiUrl) });
    let value: DataPlaneLocation | null = null;
    if (res.ok) value = Location.parse(await res.json());
    else if (res.status !== 404) throw new Error(`data-plane lookup failed: ${res.status}`);

    this.cache.set(tenantId, { value, until: Date.now() + this.ttlMs });
    return value;
  }
}
