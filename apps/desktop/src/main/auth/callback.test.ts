import { describe, expect, it } from 'vitest';
import { corsHeaders, needsRefresh, secondsUntilExpiry, validateCallback } from './callback';

const state = 'S'.repeat(43);
const good = {
  state,
  idToken: 'header.payload.signature-xxxxxxxx',
  refreshToken: 'refresh-token-xxxxxxxxxxxxxxxx',
  firebaseTenantId: 'acme-dev-x1',
  email: 'a@acme.test',
};

describe('validateCallback', () => {
  it('accepts the expected state', () => {
    expect(validateCallback(good, state)).toEqual(good);
  });

  it('rejects a wrong or missing state', () => {
    expect(validateCallback({ ...good, state: 'T'.repeat(43) }, state)).toBeNull();
    expect(validateCallback({ ...good, state: undefined }, state)).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(validateCallback({ ...good, firebaseTenantId: '../x' }, state)).toBeNull();
    expect(validateCallback('not an object', state)).toBeNull();
    expect(validateCallback({ ...good, idToken: '' }, state)).toBeNull();
  });
});

describe('corsHeaders', () => {
  it('allows only the sign-in page origin, including Private Network Access', () => {
    const h = corsHeaders('https://api.qhint.example', 'https://api.qhint.example');
    expect(h?.['access-control-allow-origin']).toBe('https://api.qhint.example');
    expect(h?.['access-control-allow-private-network']).toBe('true');
    expect(corsHeaders('https://evil.example', 'https://api.qhint.example')).toBeNull();
    expect(corsHeaders(undefined, 'https://api.qhint.example')).toBeNull();
  });
});

describe('token expiry', () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const now = 1_800_000_000_000;

  it('computes seconds until expiry', () => {
    expect(secondsUntilExpiry(jwt(now / 1000 + 3600), now)).toBe(3600);
    expect(secondsUntilExpiry('garbage', now)).toBe(0);
  });

  it('refreshes within 5 minutes of expiry', () => {
    expect(needsRefresh(jwt(now / 1000 + 3600), now)).toBe(false);
    expect(needsRefresh(jwt(now / 1000 + 120), now)).toBe(true);
    expect(needsRefresh(null, now)).toBe(true);
  });
});
