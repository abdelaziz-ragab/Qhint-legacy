/**
 * Per-tenant encryption keys behind one interface. Today: a master key (Secret Manager) from which
 * each tenant's key is derived with HKDF, so no per-tenant secrets need managing. Later: Cloud KMS
 * per tenant, or customer-managed keys, as other KeyProvider implementations.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface KeyProvider {
  /** 32-byte data key for this tenant. `keyRef` comes from the tenant's data-plane record. */
  tenantKey(tenantId: string, keyRef: string): Promise<Buffer>;
}

export class DerivedKeyProvider implements KeyProvider {
  private readonly master: Buffer;

  constructor(masterKeyBase64: string) {
    this.master = Buffer.from(masterKeyBase64, 'base64');
    if (this.master.length < 32) throw new Error('master key must be at least 32 bytes');
  }

  async tenantKey(tenantId: string, keyRef: string): Promise<Buffer> {
    // keyRef versions the derivation, so a tenant's key can be rotated by changing its record.
    return Buffer.from(hkdfSync('sha256', this.master, tenantId, `qhint:${keyRef}`, 32));
  }
}

const VERSION = 1;

/** AES-256-GCM. Output: version(1) | iv(12) | tag(16) | ciphertext. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 29 || sealed[0] !== VERSION) throw new Error('unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
}
