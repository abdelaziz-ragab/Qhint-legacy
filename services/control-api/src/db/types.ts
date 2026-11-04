/** Kysely table types for the control schema (see db/migrations/control). */
import type { ColumnType, Generated } from 'kysely';

/** Timestamp with a database default: optional on insert, always a Date when read. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  firebase_tenant_id: string | null;
  email_domains: ColumnType<string[], string[] | undefined, string[]>;
  /** jsonb, parsed by pg on read; validate with `SignInMethods` before use. */
  sign_in_methods: ColumnType<unknown, string | undefined, string>;
  created_at: Timestamp;
}

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  firebase_uid: string;
  email: string;
  role: 'employee' | 'admin';
  created_at: Timestamp;
}

export interface DataPlaneLocationsTable {
  tenant_id: string;
  endpoint: string;
  bucket: string;
  key_ref: string;
  region: Generated<string>;
  updated_at: Timestamp;
}

export interface OperatorEventsTable {
  id: Generated<string>;
  received_at: Timestamp;
  event: ColumnType<unknown, string, string>;
}

export interface ControlDB {
  'control.tenants': TenantsTable;
  'control.users': UsersTable;
  'control.data_plane_locations': DataPlaneLocationsTable;
  'control.operator_events': OperatorEventsTable;
}
