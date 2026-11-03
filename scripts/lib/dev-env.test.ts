import { describe, expect, it } from 'vitest';
import { assertLocal, isLocalUrl } from './dev-env';

describe('isLocalUrl', () => {
  it.each([
    'postgres://u:p@127.0.0.1:5432/db',
    'postgres://u:p@localhost/db',
    '127.0.0.1:9099',
    'http://[::1]:4443',
  ])('accepts %s', (url) => expect(isLocalUrl(url)).toBe(true));

  it.each(['postgres://u:p@10.0.0.5/db', 'https://storage.googleapis.com', 'db.example.com:5432'])(
    'rejects %s',
    (url) => expect(isLocalUrl(url)).toBe(false),
  );

  it('assertLocal throws without echoing the url', () => {
    expect(() => assertLocal('DATABASE_URL', 'postgres://u:secret@prod-db/db')).toThrow(
      /^DATABASE_URL must point to localhost/,
    );
    expect(() => assertLocal('DATABASE_URL', 'postgres://u:secret@prod-db/db')).not.toThrow(
      /secret/,
    );
  });
});
