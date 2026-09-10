/**
 * `npm run token:set` — give this desk its own GitLab identity.
 *
 * One prompt, one file, mode 0600, outside every repo. The point is that the
 * conductor then acts as the person sitting at this machine rather than as
 * whoever's token was pasted into a shared `.env` — which is what made a desk
 * able to claim one person's tickets and comment, push and merge as another.
 *
 * `npm run token:set -- --show` reports what would be used without changing it.
 */
import { createInterface } from 'node:readline';
import { resolveToken, writeDeskToken, DESK_TOKEN_FILE, SETUP_HINT } from '../src/lib/token.js';
import { tokenIdentity, claudeAccountEmail, usernameFromEmail } from '../src/lib/identity.js';

const G = '\x1b[32m'; const Y = '\x1b[33m'; const R = '\x1b[31m'; const D = '\x1b[2m'; const X = '\x1b[0m';

async function whoIs(): Promise<void> {
  const r = resolveToken();
  if (!r.token) {
    console.log(`  ${Y}none${X}  no GitLab token on this desk\n`);
    console.log(SETUP_HINT);
    return;
  }
  console.log(`  source  ${r.source}  ${D}${r.where}${X}`);
  const id = await tokenIdentity();
  if (!id) {
    console.log(`  ${R}GitLab did not accept it${X}, or is unreachable (VPN?)`);
    return;
  }
  console.log(`  acts as ${G}${id.username}${X}${id.bot ? ' (bot)' : ''}${id.name ? ` ${D}${id.name}${X}` : ''}`);
  // Whose token it is matters more than where it lives. The Claude account is the
  // only thing that can tell an inherited .env apart from your own.
  const mine = claudeAccountEmail();
  const signedIn = mine ? usernameFromEmail(mine) : null;
  if (signedIn && !id.bot && signedIn !== id.username) {
    console.log(`  ${R}MISMATCH${X} this desk is signed into Claude as ${signedIn} — that token is not yours`);
  } else if (r.shared) {
    console.log(`  ${Y}note${X}    .env has leaked into a run transcript before; `
      + `${D}npm run token:set${X} moves it outside the repo`);
  }
  console.log(`  ${D}claims tickets assigned to ${id.username}, plus unassigned ones${X}`);
}

async function main(): Promise<void> {
  console.log('\nOneshot desk token\n');

  if (process.argv.includes('--show')) { await whoIs(); console.log(); return; }

  console.log(`${D}Create a personal access token with scope 'api' at`);
  console.log(`https://gitlab.arbisoft.com/-/user_settings/personal_access_tokens${X}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const token = await new Promise<string>((res) => {
    rl.question('Paste your GitLab token (input is not echoed to any log): ', (a) => { rl.close(); res(a.trim()); });
  });

  if (!token) { console.log(`\n${R}Nothing entered — no change made.${X}\n`); process.exitCode = 1; return; }

  // Prove it before writing it: a token that does not work is worse than none,
  // because it fails later, inside a phase, as an unexplained 401.
  process.env.ONESHOT_GITLAB_TOKEN = token;
  const id = await tokenIdentity();
  delete process.env.ONESHOT_GITLAB_TOKEN;

  if (!id) {
    console.log(`\n${R}GitLab did not accept that token${X} (or is unreachable — check the VPN).`);
    console.log('Nothing was written.\n');
    process.exitCode = 1;
    return;
  }

  const path = writeDeskToken(token);
  console.log(`\n  ${G}saved${X}   ${path} ${D}(mode 0600)${X}`);
  console.log(`  acts as ${G}${id.username}${X}${id.bot ? ' (bot)' : ''}`);
  console.log(`  ${D}This desk now claims only tickets assigned to ${id.username}, plus unassigned ones.${X}`);
  console.log(`  ${D}GITLAB_TOKEN in .env is no longer used for this desk.${X}\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
