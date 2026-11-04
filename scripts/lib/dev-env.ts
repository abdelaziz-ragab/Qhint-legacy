/** Local development defaults. These scripts refuse to touch anything that isn't local. */
export const DEV = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://qhint:qhint_dev@127.0.0.1:5432/qhint',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? 'demo-qhint',
  authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
  storageEmulatorHost: process.env.STORAGE_EMULATOR_HOST ?? 'http://127.0.0.1:4443',
  contentBucket: process.env.CONTENT_BUCKET ?? 'qhint-dev-content',
  /** Local-only passwords for the two application roles (set by `pnpm db:migrate`). */
  rolePasswords: {
    qhint_control_app: process.env.DEV_CONTROL_DB_PASSWORD ?? 'qhint_control_dev',
    qhint_data_app: process.env.DEV_DATA_DB_PASSWORD ?? 'qhint_data_dev',
  },
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalUrl(url: string): boolean {
  const withScheme = url.includes('://') ? url : `http://${url}`;
  return LOCAL_HOSTS.has(new URL(withScheme).hostname);
}

export function assertLocal(label: string, url: string): void {
  if (!isLocalUrl(url)) {
    throw new Error(`${label} must point to localhost for dev scripts (got a non-local host)`);
  }
}
