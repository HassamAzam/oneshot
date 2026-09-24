/**
 * What `npm run setup` leaves in .env on a reconfigure. The wizard starts from
 * the existing file, so the failure these guard against is an answer the
 * operator gave being outranked by a line from the project the machine used to
 * work on — a .env that contradicts the wizard and then refuses to boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFile, legacyLines, pinPath, readKey, removeKey, removeLegacySelectors, setKey } from './envfile.js';

const ROOT = '/opt/oneshot';

/** The shape of a .env from before GITLAB_REPO_URL, as this machine's is. */
const OLD = [
  '# WORK_REPO=~/Documents/<name>',
  'ONESHOT_PROJECT=erp',
  'ONELOOP_GITLAB_API=https://gitlab.example.com/api/v4',
  'WORK_REPO=~/Documents/workstreamai',
  'WT_ROOT=~/Documents/oneshot-wt',
  'ONESHOT_SEED_FROM=~/Documents/workstreamai',
  'ONESHOT_ERP_WORK_REPO=/tmp/scoped',
  'GITLAB_TOKEN=x',
].join('\n');

test('accepting the derived default removes the old line instead of leaving it to win', () => {
  const body = pinPath(OLD, { envName: 'WORK_REPO', name: 'erp', answer: '~/Documents/erp', derived: '~/Documents/erp', root: ROOT });
  assert.equal(readKey(body, 'WORK_REPO'), null);
  // A scoped line outranks the plain one, so it goes too.
  assert.equal(readKey(body, 'ONESHOT_ERP_WORK_REPO'), null);
  // Documentation lines are not touched.
  assert.match(body, /^# WORK_REPO=~\/Documents\/<name>$/m);
  assert.equal(readKey(body, 'GITLAB_TOKEN'), 'x');
});

test('an answer that differs from the default is written in place of the old one', () => {
  const body = pinPath(OLD, { envName: 'WT_ROOT', name: 'erp', answer: '/data/erp-wt', derived: '~/Documents/erp-wt', root: ROOT });
  assert.equal(readKey(body, 'WT_ROOT'), '/data/erp-wt');
  assert.equal(body.match(/^WT_ROOT=/gm)?.length, 1);
});

test('the seed has no derived default, so it is always written', () => {
  const body = pinPath(OLD, { envName: 'ONESHOT_SEED_FROM', name: 'erp', answer: '~/Documents/erp', derived: '', root: ROOT });
  assert.equal(readKey(body, 'ONESHOT_SEED_FROM'), '~/Documents/erp');
});

test('legacy selector lines are found in both spellings and removed', () => {
  assert.deepEqual(legacyLines(OLD), ['ONESHOT_PROJECT=erp', 'ONELOOP_GITLAB_API=https://gitlab.example.com/api/v4']);
  const body = removeLegacySelectors(OLD);
  assert.deepEqual(legacyLines(body), []);
  assert.equal(readKey(body, 'WORK_REPO'), '~/Documents/workstreamai');
  // A blank line selects nothing and is not reported.
  assert.deepEqual(legacyLines('ONESHOT_PROJECT_ID=\n'), []);
});

test('setKey and removeKey touch whole keys only', () => {
  const body = 'WORK_REPO_X=1\nWORK_REPO=2\n# WORK_REPO=3';
  assert.equal(removeKey(body, 'WORK_REPO'), 'WORK_REPO_X=1\n# WORK_REPO=3');
  assert.equal(setKey(body, 'WORK_REPO', '9'), 'WORK_REPO_X=1\nWORK_REPO=9\n# WORK_REPO=3');
  assert.equal(setKey('A=1', 'B', ''), 'A=1');
});

/** Every `$` pattern String.replace gives a meaning to in a replacement string. */
const DOLLARS = ["x$'y", 'a$&b', '$1', '$$', '$`'];

test('a value full of $ patterns is written verbatim, replacing or appending', () => {
  const body = '# comment\nGITLAB_TOKEN=abc\nOTHER=1\n';
  for (const v of DOLLARS) {
    const replaced = setKey(body, 'GITLAB_TOKEN', v);
    assert.equal(replaced, `# comment\nGITLAB_TOKEN=${v}\nOTHER=1\n`, v);
    assert.equal(readKey(replaced, 'GITLAB_TOKEN'), v, v);
    const appended = setKey(body, 'SLACK_BOT_TOKEN', v);
    assert.equal(appended, `${body}\nSLACK_BOT_TOKEN=${v}`, v);
  }
});

test('pinPath writes a path full of $ patterns verbatim', () => {
  for (const v of DOLLARS) {
    const answer = `/data/${v}`;
    const body = pinPath(OLD, { envName: 'WT_ROOT', name: 'erp', answer, derived: '~/Documents/erp-wt', root: ROOT });
    assert.equal(readKey(body, 'WT_ROOT'), answer, v);
    assert.equal(body.split('\n').length, OLD.split('\n').length, v);
    assert.equal(readKey(body, 'GITLAB_TOKEN'), 'x', v);
  }
});

test('backupFile copies the file beside itself at mode 600, and never overwrites a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-envbak-'));
  try {
    const env = join(dir, '.env');
    writeFileSync(env, 'GITLAB_TOKEN=secret\n', { mode: 0o644 });
    const at = new Date(2026, 8, 24, 7, 5, 3);
    const first = backupFile(env, at);
    assert.equal(first, `${env}.bak-20260924-070503`);
    assert.equal(readFileSync(first, 'utf8'), 'GITLAB_TOKEN=secret\n');
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.equal(backupFile(env, at), `${env}.bak-20260924-070503-2`);
    assert.equal(readFileSync(first, 'utf8'), 'GITLAB_TOKEN=secret\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
