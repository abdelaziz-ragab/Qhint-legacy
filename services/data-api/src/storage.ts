/**
 * Object storage behind one interface. Uploads and downloads use short-lived signed URLs so file
 * bytes never pass through our API servers. Keys are always under t/<tenantId>/ (enforced by the
 * data-plane store and the database).
 */
import { Storage } from '@google-cloud/storage';

export interface SignedUrl {
  url: string;
  /** PUT for Cloud Storage signed URLs; POST for the local emulator's upload endpoint. */
  method: 'PUT' | 'POST' | 'GET';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageProvider {
  uploadUrl(bucket: string, key: string, contentType: string): Promise<SignedUrl>;
  downloadUrl(bucket: string, key: string): Promise<SignedUrl>;
  /** Backend-side access (processing jobs): read, write and delete objects directly. */
  read(bucket: string, key: string): Promise<Buffer>;
  write(bucket: string, key: string, data: Buffer, contentType: string): Promise<void>;
  /** Deleting something already gone is not an error. */
  remove(bucket: string, key: string): Promise<void>;
  /** Size in bytes, or null if missing. */
  size(bucket: string, key: string): Promise<number | null>;
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

  async read(bucket: string, key: string): Promise<Buffer> {
    const [data] = await this.storage.bucket(bucket).file(key).download();
    return data;
  }

  async write(bucket: string, key: string, data: Buffer, contentType: string): Promise<void> {
    await this.storage.bucket(bucket).file(key).save(data, { contentType, resumable: false });
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.storage.bucket(bucket).file(key).delete({ ignoreNotFound: true });
  }

  async size(bucket: string, key: string): Promise<number | null> {
    const file = this.storage.bucket(bucket).file(key);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [meta] = await file.getMetadata();
    return Number(meta.size ?? 0);
  }
}

/** Local development against fake-gcs-server (which doesn't verify signatures). */
export class EmulatorStorage implements StorageProvider {
  constructor(private readonly baseUrl: string) {}

  async uploadUrl(bucket: string, key: string, contentType: string): Promise<SignedUrl> {
    const url = `${this.baseUrl}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    return {
      url,
      method: 'POST',
      headers: { 'content-type': contentType },
      expiresAt: expiry().toISOString(),
    };
  }

  async downloadUrl(bucket: string, key: string): Promise<SignedUrl> {
    const url = `${this.object(bucket, key)}?alt=media`;
    return { url, method: 'GET', headers: {}, expiresAt: expiry().toISOString() };
  }

  async read(bucket: string, key: string): Promise<Buffer> {
    const res = await fetch(`${this.object(bucket, key)}?alt=media`);
    if (!res.ok) throw new Error(`storage_read_${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async write(bucket: string, key: string, data: Buffer, contentType: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(data) },
    );
    if (!res.ok) throw new Error(`storage_write_${res.status}`);
  }

  async remove(bucket: string, key: string): Promise<void> {
    const res = await fetch(this.object(bucket, key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`storage_remove_${res.status}`);
  }

  async size(bucket: string, key: string): Promise<number | null> {
    const res = await fetch(this.object(bucket, key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage_stat_${res.status}`);
    return Number(((await res.json()) as { size?: string }).size ?? 0);
  }

  private object(bucket: string, key: string): string {
    return `${this.baseUrl}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
  }
}
