import { initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface UserClaims {
  tenantId: string;
  userId: string;
  role: 'employee' | 'admin';
}

/** Writes our custom claims onto Identity Platform users. */
export interface IdentityAdmin {
  setClaims(firebaseTenantId: string, firebaseUid: string, claims: UserClaims): Promise<void>;
}

export class FirebaseIdentityAdmin implements IdentityAdmin {
  private readonly app: App;

  /** Emulator host, if any, is configured by the token verifier (same process env). */
  constructor(projectId: string) {
    this.app = initializeApp({ projectId }, `identity-admin-${projectId}`);
  }

  async setClaims(firebaseTenantId: string, firebaseUid: string, claims: UserClaims) {
    const auth = getAuth(this.app).tenantManager().authForTenant(firebaseTenantId);
    await auth.setCustomUserClaims(firebaseUid, { ...claims });
  }
}
