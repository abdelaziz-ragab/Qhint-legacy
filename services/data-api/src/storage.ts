/**
 * Object storage behind one interface. Uploads and downloads use short-lived signed URLs so file
 * bytes never pass through our API servers. Keys are always under t/<tenantId>/ (enforced by the
 * data-plane store and the database).
 */
import { Storage } from '@google-cloud/storage';

export interface SignedUrl {
  url: string;
  method: 'PUT' | 'GET';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageProvider {
  uploadUrl(bucket: string, key: string, contentType: string): Promise<SignedUrl>;
  downloadUrl(bucket: string, key: string): Promise<SignedUrl>;
}

export const SIGNED_URL_TTL_SECONDS = 5 * 60;

const expiry = () => new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);

export class GcsStorage implements StorageProvider {
  private readonly storage = new Storage();

  async uploadUrl(bucket: string, key: string, contentType: string): Promise<SignedUrl> {
    const expires = expiry();
    const [url] = await this.storage.bucket(bucket).file(key).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires,
      contentType,
    });
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: expires.toISOString(),
    };
  }

  async downloadUrl(bucket: string, key: string): Promise<SignedUrl> {
    const expires = expiry();
    const [url] = await this.storage
      .bucket(bucket)
      .file(key)
      .getSignedUrl({ version: 'v4', action: 'read', expires });
    return { url, method: 'GET', headers: {}, expiresAt: expires.toISOString() };
  }
}

/** Local development against fake-gcs-server (which doesn't verify signatures). */
export class EmulatorStorage implements StorageProvider {
  constructor(private readonly baseUrl: string) {}

  async uploadUrl(bucket: string, key: string, contentType: string): Promise<SignedUrl> {
    const url = `${this.baseUrl}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: expiry().toISOString(),
    };
  }

  async downloadUrl(bucket: string, key: string): Promise<SignedUrl> {
    const url = `${this.baseUrl}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
    return { url, method: 'GET', headers: {}, expiresAt: expiry().toISOString() };
  }
}
