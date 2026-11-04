import type { AuthContext } from '@qhint/server-kit';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { ContentDB } from './db-types';

/** The parts of the verified login that scope content access. */
export type TenantContext = Pick<AuthContext, 'tenantId' | 'userId' | 'role'>;

/**
 * Run `fn` in a transaction scoped to one tenant/user/role. Row-level security reads these
 * settings; SET LOCAL semantics (set_config(..., true)) mean they vanish at commit/rollback, so a
 * pooled connection never carries one request's tenant into the next.
 */
export async function withTenant<T>(
  db: Kysely<ContentDB>,
  ctx: TenantContext,
  fn: (trx: Transaction<ContentDB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true),
                     set_config('app.user_id', ${ctx.userId}, true),
                     set_config('app.role', ${ctx.role}, true)`.execute(trx);
    return fn(trx);
  });
}
