/**
 * The smallest Google Drive client this needs: a service-account token and
 * four calls (list, create folder, create file, update file).
 *
 * Plain REST rather than `googleapis` — that package is ~100 MB for what is a
 * JWT signed with node:crypto and a handful of fetches. Every call passes
 * `supportsAllDrives`, because the root folder lives in a Shared Drive: a
 * service account has no storage quota of its own and cannot own files in
 * My Drive at all.
 *
 * The credential is a FILE PATH (`ONESHOT_GDRIVE_CREDENTIALS`), read when a
 * token is needed and never logged; errors carry Google's message, which names
 * the problem but not the key.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GOOGLE_FOLDER } from './drivepack.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive';
/** Any one call is given this long. Drive is reporting, so a hung call must not hold a run. */
const CALL_MS = 120_000;
const DRIVE_FLAGS = 'supportsAllDrives=true';

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

export class DriveError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** The signed assertion Google exchanges for an access token. Exported for its test. */
export function signJwt(sa: ServiceAccount, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: nowSec, exp: nowSec + 3600,
  }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(sig)}`;
}

export interface DriveFile { id: string; name: string; mimeType: string; webViewLink?: string }

export class Drive {
  private token: { value: string; until: number } | null = null;

  constructor(private readonly credentialsPath: string) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const sa = JSON.parse(readFileSync(this.credentialsPath, 'utf8')) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) throw new DriveError('credential file is not a service-account key', 0);
    const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(sa, Math.floor(Date.now() / 1000)),
      }),
      signal: AbortSignal.timeout(CALL_MS),
    });
    const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new DriveError(`token: ${body.error_description ?? body.error ?? res.statusText}`, res.status);
    }
    // Five minutes' margin so a long pass never presents a token mid-expiry.
    this.token = { value: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 300) * 1000 };
    return this.token.value;
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<{ data: T; res: Response }> {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(CALL_MS),
    });
    const textBody = await res.text();
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (JSON.parse(textBody) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
      throw new DriveError(`${init.method ?? 'GET'} ${new URL(url).pathname}: ${msg}`, res.status);
    }
    return { data: (textBody ? JSON.parse(textBody) : {}) as T, res };
  }

  /** The first non-trashed child of `parent` carrying `appProperties[key] = value`. */
  async findByProperty(parent: string, key: string, value: string): Promise<DriveFile | null> {
    const q = `'${parent}' in parents and trashed = false and appProperties has { key='${key}' and value='${value.replace(/['\\]/g, '\\$&')}' }`;
    const params = new URLSearchParams({
      q, fields: 'files(id,name,mimeType,webViewLink)', pageSize: '10',
      corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
    });
    const { data } = await this.call<{ files: DriveFile[] }>(`${API}/files?${params}`);
    return data.files[0] ?? null;
  }

  async get(id: string): Promise<DriveFile> {
    return (await this.call<DriveFile>(`${API}/files/${id}?fields=id,name,mimeType,webViewLink&${DRIVE_FLAGS}`)).data;
  }

  async createFolder(parent: string, name: string, props: Record<string, string>, description?: string): Promise<DriveFile> {
    const { data } = await this.call<DriveFile>(`${API}/files?fields=id,name,mimeType,webViewLink&${DRIVE_FLAGS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: GOOGLE_FOLDER, parents: [parent], appProperties: props, description }),
    });
    return data;
  }

  async patchMeta(id: string, meta: { name?: string; description?: string }): Promise<void> {
    await this.call(`${API}/files/${id}?${DRIVE_FLAGS}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta),
    });
  }

  /**
   * Create (no `id`) or replace the content of (`id`) one file. Always the
   * resumable protocol: it is two requests either way and has no 5 MB ceiling,
   * which a demo video passes. Replacing keeps the file id, link and Drive's
   * revision history — re-runs update in place, never duplicate.
   */
  async upload(opts: {
    id?: string; parent: string; name: string; mime: string; convertTo?: string;
    props: Record<string, string>; content: Buffer;
  }): Promise<DriveFile> {
    const meta: Record<string, unknown> = { name: opts.name };
    if (!opts.id) {
      meta.parents = [opts.parent];
      meta.appProperties = opts.props;
      if (opts.convertTo) meta.mimeType = opts.convertTo;
    }
    const base = opts.id ? `${UPLOAD}/files/${opts.id}` : `${UPLOAD}/files`;
    const { res } = await this.call(`${base}?uploadType=resumable&${DRIVE_FLAGS}`, {
      method: opts.id ? 'PATCH' : 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': opts.mime,
        'x-upload-content-length': String(opts.content.length),
      },
      body: JSON.stringify(meta),
    });
    const session = res.headers.get('location');
    if (!session) throw new DriveError('upload: no resumable session returned', res.status);
    const { data } = await this.call<DriveFile>(`${session}&fields=id,name,mimeType,webViewLink`, {
      method: 'PUT', headers: { 'content-type': opts.mime }, body: opts.content,
    });
    return data;
  }
}
