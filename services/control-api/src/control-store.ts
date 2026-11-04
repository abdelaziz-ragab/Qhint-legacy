/** Control-plane data access: tenants, users, data-plane locations, operator events. */
import type { OperatorEvent } from '@qhint/schema';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { ControlDB } from './db/types';

/** A company's single sign-on provider (an Identity Platform SAML or OIDC provider). */
export const SsoProvider = z.object({
  type: z.enum(['saml', 'oidc']),
  providerId: z.string().regex(/^(saml|oidc)\.[A-Za-z0-9_-]{1,64}$/),
  label: z.string().max(60),
});

/** Sign-in methods a company offers on the sign-in page (`control.tenants.sign_in_methods`). */
export const SignInMethods = z.object({
  password: z.boolean(),
  google: z.boolean(),
  microsoft: z.boolean(),
  sso: SsoProvider.nullable(),
});
export type SignInMethods = z.infer<typeof SignInMethods>;

export const DEFAULT_SIGN_IN_METHODS: SignInMethods = {
  password: true,
  google: true,
  microsoft: false,
  sso: null,
};

/** Stored value -> methods; anything invalid falls back to the default instead of failing sign-in. */
export function parseSignInMethods(stored: unknown): SignInMethods {
  const r = SignInMethods.safeParse(stored);
  return r.success ? r.data : { ...DEFAULT_SIGN_IN_METHODS };
}

export interface TenantRecord {
  id: string;
  name: string;
  firebaseTenantId: string | null;
  signInMethods: SignInMethods;
}

export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  role: 'employee' | 'admin';
  firebaseUid: string | null;
}

export interface DataPlaneLocation {
  tenantId: string;
  firebaseTenantId: string;
  endpoint: string;
  bucket: string;
  keyRef: string;
  region: string;
}

export interface ControlStore {
  /** Which tenant should this email sign in to? Invited email first, then email domain. */
  tenantForEmail(email: string): Promise<TenantRecord | null>;
  tenant(id: string): Promise<TenantRecord | null>;
  tenantByFirebaseTenant(firebaseTenantId: string): Promise<TenantRecord | null>;
  userByEmail(tenantId: string, email: string): Promise<UserRecord | null>;
  linkFirebaseUid(userId: string, firebaseUid: string): Promise<void>;
  dataPlane(tenantId: string): Promise<DataPlaneLocation | null>;
  insertEvents(events: OperatorEvent[]): Promise<void>;
}

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

export class PgControlStore implements ControlStore {
  constructor(private readonly db: Kysely<ControlDB>) {}

  private toTenant(r: {
    id: string;
    name: string;
    firebase_tenant_id: string | null;
    sign_in_methods: unknown;
  }): TenantRecord {
    return {
      id: r.id,
      name: r.name,
      firebaseTenantId: r.firebase_tenant_id,
      signInMethods: parseSignInMethods(r.sign_in_methods),
    };
  }

  async tenantForEmail(email: string): Promise<TenantRecord | null> {
    const invited = await this.db
      .selectFrom('control.users as u')
      .innerJoin('control.tenants as t', 't.id', 'u.tenant_id')
      .select(['t.id', 't.name', 't.firebase_tenant_id', 't.sign_in_methods'])
      .where(sql<boolean>`lower(u.email) = ${email.toLowerCase()}`)
      .limit(2)
      .execute();
    // The same email invited to two tenants is ambiguous: fall through to the domain rule.
    if (invited.length === 1) return this.toTenant(invited[0]!);

    const byDomain = await this.db
      .selectFrom('control.tenants')
      .select(['id', 'name', 'firebase_tenant_id', 'sign_in_methods'])
      .where(sql<boolean>`${domainOf(email)} = ANY(email_domains)`)
      .limit(2)
      .execute();
    return byDomain.length === 1 ? this.toTenant(byDomain[0]!) : null;
  }

  async tenant(id: string) {
    const r = await this.db
      .selectFrom('control.tenants')
      .select(['id', 'name', 'firebase_tenant_id', 'sign_in_methods'])
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? this.toTenant(r) : null;
  }

  async tenantByFirebaseTenant(firebaseTenantId: string) {
    const r = await this.db
      .selectFrom('control.tenants')
      .select(['id', 'name', 'firebase_tenant_id', 'sign_in_methods'])
      .where('firebase_tenant_id', '=', firebaseTenantId)
      .executeTakeFirst();
    return r ? this.toTenant(r) : null;
  }

  async userByEmail(tenantId: string, email: string): Promise<UserRecord | null> {
    const r = await this.db
      .selectFrom('control.users')
      .select(['id', 'tenant_id', 'email', 'role', 'firebase_uid'])
      .where('tenant_id', '=', tenantId)
      .where(sql<boolean>`lower(email) = ${email.toLowerCase()}`)
      .executeTakeFirst();
    return r
      ? {
          id: r.id,
          tenantId: r.tenant_id,
          email: r.email,
          role: r.role,
          firebaseUid: r.firebase_uid,
        }
      : null;
  }

  async linkFirebaseUid(userId: string, firebaseUid: string) {
    await this.db
      .updateTable('control.users')
      .set({ firebase_uid: firebaseUid })
      .where('id', '=', userId)
      .where('firebase_uid', 'is', null)
      .execute();
  }

  async dataPlane(tenantId: string): Promise<DataPlaneLocation | null> {
    const r = await this.db
      .selectFrom('control.data_plane_locations as d')
      .innerJoin('control.tenants as t', 't.id', 'd.tenant_id')
      .select([
        'd.tenant_id',
        't.firebase_tenant_id',
        'd.endpoint',
        'd.bucket',
        'd.key_ref',
        'd.region',
      ])
      .where('d.tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!r || !r.firebase_tenant_id) return null;
    return {
      tenantId: r.tenant_id,
      firebaseTenantId: r.firebase_tenant_id,
      endpoint: r.endpoint,
      bucket: r.bucket,
      keyRef: r.key_ref,
      region: r.region,
    };
  }

  async insertEvents(events: OperatorEvent[]) {
    if (events.length === 0) return;
    await this.db
      .insertInto('control.operator_events')
      .values(events.map((e) => ({ event: JSON.stringify(e) })))
      .execute();
  }
}
