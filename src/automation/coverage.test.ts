import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  deriveTerms, deriveModules, specChecks, candidateSpecs, renderCoverage, coverageNote, gatherCoverage,
  normalizeTokens, tabsToSearch, type CoverageReport,
} from './coverage.js';
import type { AutomationTicket, MergedChange } from './context.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const impact = require(join(REPO_ROOT, 'skills', 'local-tests-impact', 'scripts', 'index.cjs'));

function ticket(over: Partial<AutomationTicket> = {}): AutomationTicket {
  return { iid: 8420, title: 'Bug', description: '', labels: [], state: 'closed', url: 'u', comments: [], ...over };
}
function changes(paths: string[]): MergedChange[] {
  return [{
    mr: { iid: 1, state: 'merged' } as MergedChange['mr'],
    description: null,
    files: paths.map((p) => ({ new_path: p, old_path: p, diff: '' } as MergedChange['files'][number])),
    complete: true,
  }];
}

test('deriveTerms strips the title tag, keeps quoted phrases and code symbols, drops stopwords', () => {
  const t = ticket({
    title: '[Profile] Blocked Notifications not saved',
    description: 'The "Automated birthday wish notification" option is lost after reload.',
  });
  const terms = deriveTerms(t, changes(['apps/profile/person_approver.py']));
  assert.ok(terms.phrases.includes('automated birthday wish notification'), 'quoted label kept as a phrase');
  assert.ok(terms.phrases.includes('person_approver'), 'changed code identifier kept as a phrase');
  assert.ok(terms.words.includes('blocked'), 'meaningful title word kept');
  assert.ok(terms.words.includes('notifications'), 'meaningful title word kept');
  assert.ok(!terms.words.includes('not'), 'stopword dropped');
  assert.ok(!terms.words.some((w) => w.length < 4), 'short tokens dropped');
  assert.ok(terms.phrases.includes('blocked notifications'), 'a Title-Case run in the title is kept as a phrase');
});

test('normalizeTokens bridges a spec constant and a human label', () => {
  assert.equal(normalizeTokens('AUTOMATED_BIRTHDAY_WISH_NOTIFICATION'), 'automated birthday wish notification');
  assert.equal(normalizeTokens('BlockedTeamUpdatesDropdownOptions'), 'blocked team updates dropdown options');
});

test('candidateSpecs matches a spec that names the label only as a CONSTANT', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wsa-const-'));
  try {
    mkdirSync(join(repo, 'cypress/e2e/profileA'), { recursive: true });
    // The team's real style: the label lives in a constant, never as the human string.
    writeFileSync(join(repo, 'cypress/e2e/profileA/profile_17.ts'),
      "it('change preference settings', () => { cy.get(x).select(BlockedNotificationType.AUTOMATED_BIRTHDAY_WISH_NOTIFICATION).getSuccessToast(); });");
    const found = candidateSpecs(repo, [], { phrases: ['automated birthday wish notification'], words: [] });
    assert.equal(found.length, 1, 'the spec is found with no module hint, by the normalised constant');
    assert.equal(found[0]!.strength, 'phrase');
    assert.ok(found[0]!.assertions >= 1, 'getSuccessToast counts as an assertion');
    assert.equal(found[0]!.reloads, false, 'a toast-only spec is not a re-read');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deriveModules maps a frontend change to its e2e folders', () => {
  const map = impact.loadMap();
  const r = deriveModules(changes(['frontend/src/components/profile/BasicInfo.js']), map);
  assert.ok(r.e2e.includes('profileA') && r.e2e.includes('profileB'), 'profile maps to profileA/profileB');
  assert.equal(r.notes.length, 0, 'a mapped change leaves no shared-code caveat');
});

test('deriveModules notes shared code that maps to no module', () => {
  const map = impact.loadMap();
  const r = deriveModules(changes(['apps/core/models.py']), map);
  assert.equal(r.e2e.length, 0, 'shared code maps to no e2e folder');
  assert.ok(r.notes.some((n) => /shared code/.test(n) && /core/.test(n)), 'the shared caveat names the area');
});

test('specChecks reads it() titles and distinguishes a re-read spec from a toast-only one', () => {
  const reread = specChecks(`
    describe('Profile', () => {
      it('saves the blocked notification', () => {
        cy.get('[data-testid="save"]').click();
        cy.reload();
        cy.get('.list').should('contain', 'Automated birthday wish notification');
      });
    });
  `);
  assert.ok(reread.checks.includes('saves the blocked notification'));
  assert.equal(reread.reloads, true);
  assert.ok(reread.assertions >= 1);

  const toastOnly = specChecks(`
    it('shows the success toast', () => {
      cy.get('[data-testid="save"]').click();
      getSuccessToast();
    });
  `);
  assert.equal(toastOnly.reloads, false, 'a toast-only spec does not re-read');
  assert.ok(toastOnly.assertions >= 1, 'getSuccessToast is counted as an assertion (the suite asserts through custom commands)');

  const commented = specChecks("// it('ignored because commented out', () => {})\nit('real', () => { expect(1).to.eq(1); });");
  assert.deepEqual(commented.checks, ['real'], 'a commented-out it() is not a check');
});

test('candidateSpecs finds specs by module and by a distinctive phrase, not by a bare word outside the module', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wsa-'));
  try {
    const write = (rel: string, src: string): void => {
      mkdirSync(join(repo, dirname(rel)), { recursive: true });
      writeFileSync(join(repo, rel), src);
    };
    write('cypress/e2e/profileA/profile_17.ts', "it('changes preference settings', () => { cy.reload(); cy.get('x').should('exist'); });");
    write('cypress/e2e/home/HM_56.ts', "it('blocked notifications on home', () => { cy.contains('Automated birthday wish notification'); });");
    write('cypress/e2e/payroll/PRL_07.ts', "it('people report', () => { cy.get('x').should('exist'); });");

    const found = candidateSpecs(repo, ['profileA'], { phrases: ['automated birthday wish notification'], words: ['report'] });
    const files = found.map((s) => s.file);
    assert.ok(files.includes('cypress/e2e/profileA/profile_17.ts'), 'module hit found');
    assert.ok(files.includes('cypress/e2e/home/HM_56.ts'), 'phrase hit found anywhere');
    assert.ok(!files.includes('cypress/e2e/payroll/PRL_07.ts'), 'a bare word does not match outside the mapped module');

    const profile = found.find((s) => s.file.endsWith('profile_17.ts'))!;
    assert.equal(profile.strength, 'module', 'a same-folder spec with no phrase is a weak module hit');
    assert.equal(profile.reloads, true);
    const home = found.find((s) => s.file.endsWith('HM_56.ts'))!;
    assert.equal(home.strength, 'phrase', 'a spec naming the label is a strong phrase hit');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('tabsToSearch picks the ticket\'s own module tab, not one a loose word matched', () => {
  // The real #8420 shape: labelled Profile, title mentions "Blocked Team Updates".
  const modules = [
    { tab: 'TestCases_Profile', module: 'Profile' },
    { tab: 'TestCases_Team Management', module: 'Team Management' },
    { tab: 'Team Reviews [Latest]', module: 'Team Reviews' },
  ];
  const terms = { phrases: ['blocked team updates'], words: ['blocked', 'team', 'updates'] };
  const tabs = tabsToSearch(modules, ['Profile', 'Ready For Automation'], terms);
  assert.deepEqual(tabs, ['TestCases_Profile'], 'the Profile label wins; "team" does not pull in Team tabs');
});

test('renderCoverage separates "did not look" from "found nothing"', () => {
  const base: CoverageReport = {
    checked: { cypress: true, sheet: false, tracker: false },
    terms: ['blocked'], modules: ['profileA'], specs: [], sheet: [], tracker: [], notes: [],
  };
  const none = renderCoverage(base);
  assert.match(none, /No spec names this change directly/, 'a reached-but-empty Cypress source says so');
  assert.doesNotMatch(none, /Manual cases/, 'an unreached sheet source is not rendered as empty');

  const withSpec = renderCoverage({
    ...base,
    specs: [{ file: 'cypress/e2e/profileA/profile_17.ts', module: 'profileA', strength: 'phrase', why: 'names "blocked notifications"', checks: ['saves it'], reloads: false, assertions: 1 }],
  });
  assert.match(withSpec, /profile_17\.ts/);
  assert.match(withSpec, /may only check the immediate response/, 'a no-reload spec is flagged as shallow coverage');

  const moduleOnly = renderCoverage({
    ...base,
    specs: [{ file: 'cypress/e2e/profileA/profile_20.ts', module: 'profileA', strength: 'module', why: 'in module profileA', checks: ['add experience'], reloads: true, assertions: 3 }],
  });
  assert.match(moduleOnly, /Other specs in the same module/, 'a module-only spec is not presented as naming the change');
  assert.doesNotMatch(moduleOnly, /specs that name this change \(/, 'no phrase section when there are no phrase hits');
});

test('coverageNote states what was checked and warns when a source was not', () => {
  const note = coverageNote({
    checked: { cypress: true, sheet: true, tracker: true },
    terms: [], modules: [], tracker: [],
    specs: [{ file: 'a', module: 'm', strength: 'phrase', why: 'w', checks: [], reloads: true, assertions: 2 }],
    sheet: [{ tab: 'TestCases_Profile', rows: ['row 1 — 366.1: x'] }],
    notes: [],
  });
  assert.ok(note.some((l) => /Existing coverage checked/.test(l)));
  assert.ok(note.some((l) => l.includes('`TestCases_Profile`')), 'tab name is backticked so it cannot read as emphasis');

  const off = coverageNote({
    checked: { cypress: false, sheet: false, tracker: false },
    terms: [], modules: [], specs: [], sheet: [], tracker: [], notes: [],
  });
  assert.ok(off.some((l) => /not checked against Cypress or the sheet/.test(l)));
});

test('gatherCoverage never throws and reports nothing as checked when no source is configured', async () => {
  const r = await gatherCoverage({ iid: 8420, ticket: ticket(), changes: changes(['apps/core/models.py']), year: 2026 });
  assert.equal(r.checked.cypress, false);
  assert.equal(r.checked.sheet, false);
  assert.equal(r.checked.tracker, false);
  assert.ok(r.notes.some((n) => /ONESHOT_LOCAL_TESTS_REPO/.test(n)), 'says the clone is not on this desk');
  assert.ok(r.notes.some((n) => /sheet is not configured/.test(n)), 'says the sheet is not configured');
});
