import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DerivedKeyProvider, open, seal } from './keys';

const keys = new DerivedKeyProvider(randomBytes(32).toString('base64'));

describe('DerivedKeyProvider', () => {
  it('gives each tenant a different, stable key', async () => {
    const a1 = await keys.tenantKey('tenant-a', 'v1');
    expect(await keys.tenantKey('tenant-a', 'v1')).toEqual(a1);
    expect(await keys.tenantKey('tenant-b', 'v1')).not.toEqual(a1);
    expect(await keys.tenantKey('tenant-a', 'v2')).not.toEqual(a1);
    expect(a1).toHaveLength(32);
  });

  it('rejects weak master keys', () => {
    expect(() => new DerivedKeyProvider(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('seal / open', () => {
  it('round-trips', async () => {
    const k = await keys.tenantKey('tenant-a', 'v1');
    expect(open(k, seal(k, Buffer.from('secret step'), 'doc:1'), 'doc:1').toString()).toBe(
      'secret step',
    );
  });

  it("another tenant's key cannot decrypt", async () => {
    const a = await keys.tenantKey('tenant-a', 'v1');
    const b = await keys.tenantKey('tenant-b', 'v1');
    expect(() => open(b, seal(a, Buffer.from('x'), 'doc:1'), 'doc:1')).toThrow();
  });

  it('detects tampering and wrong context', async () => {
    const k = await keys.tenantKey('tenant-a', 'v1');
    const sealed = seal(k, Buffer.from('hello'), 'doc:1');
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => open(k, tampered, 'doc:1')).toThrow();
    expect(() => open(k, sealed, 'doc:2')).toThrow();
  });
});
