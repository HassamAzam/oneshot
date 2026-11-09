/**
 * `npm run drive:login -- --client <client_secret.json> --out <path> [--root-name <name>]`
 *
 * One-time sign-in for orgs where the Drive folders cannot live in a Shared
 * Drive shared with a service account. The person running it signs in in their
 * own browser; the script keeps only a refresh token on the `drive.file`
 * scope — Oneshot can then see the files it creates and nothing else in that
 * person's Drive — writes it to `--out` with mode 600, and creates the root
 * folder (which, under that scope, has to be one this app made).
 *
 * `--client` is the "Desktop app" OAuth client JSON downloaded from Google
 * Cloud. Run this on a machine with a browser; copy the --out file to the
 * server afterwards. Nothing secret is printed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { expandPath } from '../src/lib/config.js';
import { Drive, TOKEN_URI, consentUrl, type AuthorizedUser } from '../src/lib/gdrive.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const clientPath = arg('client');
  const outArg = arg('out');
  if (!clientPath || !outArg) {
    console.error('usage: npm run drive:login -- --client <client_secret.json> --out <path> [--root-name <name>]');
    process.exit(1);
  }
  const out = expandPath(outArg);
  const raw = JSON.parse(readFileSync(expandPath(clientPath), 'utf8')) as Record<string, { client_id?: string; client_secret?: string }>;
  const client = raw.installed ?? raw.web;
  if (!client?.client_id || !client.client_secret) {
    console.error('That file is not an OAuth client JSON (expected an "installed" block — create a Desktop app client).');
    process.exit(1);
  }

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const got = url.searchParams.get('code');
      const ok = got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' })
        .end(ok ? 'Signed in. You can close this tab.' : `Sign-in failed: ${url.searchParams.get('error') ?? 'bad state'}`);
      server.close();
      if (ok) resolve({ code: got!, redirect }); else reject(new Error(url.searchParams.get('error') ?? 'state mismatch'));
    });
    let redirect = '';
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      redirect = `http://127.0.0.1:${port}/`;
      const url = consentUrl(client.client_id!, redirect, challenge, state);
      console.log(`Opening the Google sign-in page. If it does not open, visit:\n\n${url}\n`);
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => undefined);
    });
    setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')); }, 300_000).unref();
  });

  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: code.code, redirect_uri: code.redirect, code_verifier: verifier,
      client_id: client.client_id, client_secret: client.client_secret,
    }),
  });
  const body = await res.json() as { refresh_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.refresh_token) {
    console.error(`Token exchange failed: ${body.error_description ?? body.error ?? res.statusText}`);
    process.exit(1);
  }
  const cred: AuthorizedUser = {
    type: 'authorized_user', client_id: client.client_id, client_secret: client.client_secret, refresh_token: body.refresh_token,
  };
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`Saved the sign-in to ${out} (mode 600).`);

  const rootName = arg('root-name') ?? 'Oneshot tickets';
  const root = await new Drive(out).createFolder(null, rootName, { oneshotRoot: '1' });
  console.log(`Created "${rootName}" at the top of your My Drive. Move or share it as you like; put this in .env:\n`);
  console.log(`ONESHOT_GDRIVE_ROOT=${root.id}`);
  console.log(`ONESHOT_GDRIVE_CREDENTIALS=${outArg}`);
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });
