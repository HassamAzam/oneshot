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
 * the problem but not the key. Two kinds are accepted, told apart by the file:
 *
 * - a service-account key (`private_key`): the account sees only folders shared
 *   with it, and the root must sit in a Shared Drive because it has no quota;
 * - an `authorized_user` file written by `npm run drive:login`: a person's
 *   refresh token on the `drive.file` scope, for orgs where a Shared Drive or
 *   sharing with an outside address is not allowed. That scope sees only files
 *   this app created — so the root folder is one the login script made too.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GOOGLE_FOLDER } from './drivepack.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive';
/** A person's login is held to files this app created: nothing else in their Drive is visible. */
export const USER_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Any one call is given this long. Drive is reporting, so a hung call must not hold a run. */
const CALL_MS = 120_000;
const DRIVE_FLAGS = 'supportsAllDrives=true';

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
export interface AuthorizedUser { type: 'authorized_user'; client_id: string; client_secret: string; refresh_token: string }

/** The grant a credential file is exchanged with, or why it is neither kind. */
export function tokenRequest(cred: Record<string, unknown>, nowSec: number): URLSearchParams {
  if (cred.type === 'authorized_user') {
    const u = cred as unknown as AuthorizedUser;
    if (!u.client_id || !u.client_secret || !u.refresh_token) throw new DriveError('authorized_user file is missing a field', 0);
    return new URLSearchParams({
      grant_type: 'refresh_token', client_id: u.client_id, client_secret: u.client_secret, refresh_token: u.refresh_token,
    });
  }
  const sa = cred as unknown as ServiceAccount;
  if (!sa.client_email || !sa.private_key) {
    throw new DriveError('credential file is neither a service-account key nor an authorized_user file', 0);
  }
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa, nowSec),
  });
}

/**
 * fetch, retried once after a network-level failure ("fetch failed": a reset or
 * DNS blip, never an HTTP status). The first live pass from a desk died on
 * exactly one of those, and a pass that gives up costs a whole phase's wait.
 * A body that is a Buffer or string is safe to resend; HTTP errors are not
 * retried here, so nothing Google refused is ever sent twice.
 */
async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_MS) });
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return fetch(url, { ...init, signal: AbortSignal.timeout(CALL_MS) });
  }
}

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
    const cred = JSON.parse(readFileSync(this.credentialsPath, 'utf8')) as Record<string, unknown>;
    const res = await fetchOnce(typeof cred.token_uri === 'string' ? cred.token_uri : TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenRequest(cred, Math.floor(Date.now() / 1000)),
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
    const res = await fetchOnce(url, {
      ...init,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(init.headers ?? {}) },
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

  /** `parent` null makes it at the top of the caller's My Drive — only `drive:login` does that. */
  async createFolder(parent: string | null, name: string, props: Record<string, string>, description?: string): Promise<DriveFile> {
    const { data } = await this.call<DriveFile>(`${API}/files?fields=id,name,mimeType,webViewLink&${DRIVE_FLAGS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name, mimeType: GOOGLE_FOLDER, ...(parent ? { parents: [parent] } : {}), appProperties: props, description,
      }),
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

/**
 * The consent page `drive:login` sends a person to. Offline access and a
 * forced consent prompt are what make Google return a refresh token every
 * time; PKCE means a leaked code alone cannot be exchanged.
 */
export function consentUrl(clientId: string, redirectUri: string, challenge: string, state: string): string {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: USER_SCOPE,
    access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
  })}`;
}

/**
 * The authorization code out of what a person pasted back in `--no-browser`
 * mode: the whole address their browser landed on (the 127.0.0.1 page that
 * fails to load on their Mac), or the bare code. A pasted address must carry
 * this sign-in's `state`, so a stale or foreign redirect is refused.
 */
export function codeFromPasted(pasted: string, state: string): string {
  const s = pasted.trim();
  if (!/^https?:\/\//i.test(s)) {
    if (!s || /\s/.test(s)) throw new Error('nothing that looks like an address or a code was pasted');
    return s;
  }
  const u = new URL(s);
  const err = u.searchParams.get('error');
  if (err) throw new Error(`Google refused the sign-in: ${err}`);
  if (u.searchParams.get('state') !== state) throw new Error('that address is from a different sign-in attempt — start again');
  const code = u.searchParams.get('code');
  if (!code) throw new Error('the pasted address carries no code');
  return code;
}
