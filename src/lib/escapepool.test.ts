/**
 * Pooling several desks' sweeps. Every test here is a way the naive version —
 * concatenate the rows — reports a number that is wrong rather than merely
 * incomplete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_FOR_RATE } from './escapes.js';
import { poolReports, type DeskReport, type SweepRow } from './escapepool.js';

const ERP = 'gitlab.arbisoft.com/arbisoft/erp';

function row(iid: number, over: Partial<SweepRow> = {}): SweepRow {
  return {
    iid, runId: `r-${iid}`, mergedSha: `m${iid}`, oneshotSha: 'sha-a', archived: false,
    record: {
      verdict: 'clean', openedAt: 1_000, closedAt: 2_000, rounds: [], signOffWithdrawn: false,
    },
    error: null,
    ...over,
  };
}

const escaped = (iid: number, over: Partial<SweepRow> = {}): SweepRow => row(iid, {
  record: {
    verdict: 'escaped', openedAt: 1_000, closedAt: 2_000,
    rounds: [{ at: 1_500, by: 'anosha.saeed' }], signOffWithdrawn: false,
  },
  ...over,
});

const desk = (name: string, rows: SweepRow[], project = ERP): DeskReport =>
  ({ desk: name, project, sweptAt: 9_000, rows });

test('pooling two desks sums their cohorts', () => {
  const p = poolReports([desk('anosha', [row(1), escaped(2)]), desk('hassam', [row(3), row(4)])]);
  assert.equal(p.rows.length, 4);
  assert.equal(p.rate.settled, 4);
  assert.equal(p.rate.escaped, 1);
  assert.deepEqual(p.desks.map((d) => d.desk), ['anosha', 'hassam']);
});

test('the same ticket on two desks is counted once, not twice', () => {
  // A run that stalled on one desk and was re-claimed on another leaves a
  // journal on both. Counted twice it doubles its weight in the rate.
  const p = poolReports([desk('anosha', [escaped(10)]), desk('hassam', [escaped(10)])]);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rate.settled, 1);
  assert.equal(p.rate.escaped, 1);
  assert.deepEqual(p.rows[0]!.alsoOn, ['hassam']);
});

test('a readable copy beats an unreadable one — the point of pooling', () => {
  const blind = row(11, { record: null, error: 'HTTP 403' });
  const p = poolReports([desk('anosha', [blind]), desk('hassam', [escaped(11)])]);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0]!.record?.verdict, 'escaped');
  assert.equal(p.rows[0]!.desk, 'hassam');
  assert.equal(p.unreadable.length, 0);
});

test('between two shipped copies the LATER merge wins, so the right version is credited', () => {
  const first = escaped(12, { oneshotSha: 'sha-old' });
  const later = escaped(12, {
    oneshotSha: 'sha-new',
    record: {
      verdict: 'escaped', openedAt: 5_000, closedAt: 6_000,
      rounds: [{ at: 5_500, by: 'anosha.saeed' }], signOffWithdrawn: false,
    },
  });
  const p = poolReports([desk('anosha', [first]), desk('hassam', [later])]);
  assert.equal(p.rows[0]!.oneshotSha, 'sha-new');
  assert.deepEqual(p.byVersion, [{ oneshotSha: 'sha-new', settled: 1, escaped: 1 }]);
});

test('two projects are refused, never pooled into one percentage', () => {
  assert.throws(
    () => poolReports([desk('anosha', [row(1)]), desk('other', [row(2)], 'gitlab.example.com/x/y')]),
    /different projects/,
  );
});

test('two readable copies that disagree are surfaced, not silently resolved', () => {
  const p = poolReports([desk('anosha', [escaped(13)]), desk('hassam', [row(13)])]);
  assert.equal(p.conflicts.length, 1);
  assert.equal(p.conflicts[0]!.iid, 13);
  assert.deepEqual(p.conflicts[0]!.verdicts.map((v) => v.verdict).sort(), ['clean', 'escaped']);
});

test('an unreadable copy disagreeing with a readable one is routine, not a conflict', () => {
  const p = poolReports([
    desk('anosha', [row(14, { record: null, error: 'HTTP 403' })]),
    desk('hassam', [escaped(14)]),
  ]);
  assert.deepEqual(p.conflicts, []);
});

test('open tickets are pooled but never rated', () => {
  const open = row(15, {
    record: { verdict: 'open', openedAt: 1_000, closedAt: null, rounds: [], signOffWithdrawn: false },
  });
  const p = poolReports([desk('anosha', [open, row(16)])]);
  assert.equal(p.rate.open, 1);
  assert.equal(p.rate.settled, 1);
  assert.deepEqual(p.byVersion, [{ oneshotSha: 'sha-a', settled: 1, escaped: 0 }]);
});

test('the pooled rate is still withheld until the fleet has enough settled tickets', () => {
  const thin = poolReports([desk('anosha', [row(1), escaped(2)]), desk('hassam', [row(3)])]);
  assert.equal(thin.rate.rate, null, 'three tickets must not produce a percentage');

  const enough = poolReports([
    desk('anosha', Array.from({ length: 6 }, (_, i) => row(100 + i))),
    desk('hassam', Array.from({ length: MIN_FOR_RATE - 6 }, (_, i) => escaped(200 + i))),
  ]);
  assert.equal(enough.rate.settled, MIN_FOR_RATE);
  assert.equal(enough.rate.rate, (MIN_FOR_RATE - 6) / MIN_FOR_RATE);
});

test('versions are bucketed across the whole pool, which is the comparison', () => {
  const p = poolReports([
    desk('anosha', [row(1, { oneshotSha: 'before' }), escaped(2, { oneshotSha: 'before' })]),
    desk('hassam', [row(3, { oneshotSha: 'after' }), row(4, { oneshotSha: 'after' })]),
  ]);
  assert.deepEqual(p.byVersion, [
    { oneshotSha: 'after', settled: 2, escaped: 0 },
    { oneshotSha: 'before', settled: 2, escaped: 1 },
  ]);
});

test('pooling nothing is an error, not an empty perfect score', () => {
  assert.throws(() => poolReports([]), /no desk reports/);
});

/**
 * Found in self-review, and the worst of the pooling bugs. `prefer` compared
 * `openedAt` — the merge time, identical on two copies of the SAME ticket — so
 * neither could ever beat the other and whichever desk happened to be read
 * first won. A desk that swept before sign-off therefore contributed `open`,
 * and a ticket that had in fact settled vanished from the rate.
 */
test('a desk that swept before sign-off does not beat one that swept after', () => {
  const openRec = {
    verdict: 'open' as const, openedAt: 1_000, closedAt: null, rounds: [], signOffWithdrawn: false,
  };
  const early = desk('swept-early', [row(20, { record: openRec })]);
  const late = desk('swept-late', [row(20)]);

  // Both orderings, because the bug was that whichever came first won.
  for (const reports of [[early, late], [late, early]]) {
    const p = poolReports(reports);
    assert.equal(p.rows[0]!.record?.verdict, 'clean', 'the stale sweep won');
    assert.equal(p.rate.settled, 1);
    assert.equal(p.rate.open, 0);
    assert.deepEqual(p.conflicts, [], 'staleness is not a conflict');
  }
});

test('an indeterminate copy beats open but loses to a final verdict', () => {
  const mk = (v: 'open' | 'indeterminate' | 'clean') => row(21, {
    record: { verdict: v, openedAt: 1_000, closedAt: v === 'open' ? null : 2_000, rounds: [], signOffWithdrawn: false },
  });
  assert.equal(poolReports([desk('a', [mk('open')]), desk('b', [mk('indeterminate')])])
    .rows[0]!.record?.verdict, 'indeterminate');
  assert.equal(poolReports([desk('a', [mk('indeterminate')]), desk('b', [mk('clean')])])
    .rows[0]!.record?.verdict, 'clean');
});

test('only two FINAL verdicts disagreeing is a conflict worth a person looking', () => {
  // clean vs escaped on the same label history means one sweep is wrong.
  const real = poolReports([desk('a', [escaped(22)]), desk('b', [row(22)])]);
  assert.equal(real.conflicts.length, 1);

  // open vs clean is just one desk being early — resolved, not reported.
  const stale = poolReports([
    desk('a', [row(23, { record: { verdict: 'open', openedAt: 1, closedAt: null, rounds: [], signOffWithdrawn: false } })]),
    desk('b', [row(23)]),
  ]);
  assert.deepEqual(stale.conflicts, []);
});

test('when two desks are equally settled the fresher sweep wins', () => {
  const a = { desk: 'a', project: ERP, sweptAt: 100, rows: [row(24, { oneshotSha: 'older' })] };
  const b = { desk: 'b', project: ERP, sweptAt: 900, rows: [row(24, { oneshotSha: 'newer' })] };
  assert.equal(poolReports([a, b]).rows[0]!.oneshotSha, 'newer');
  assert.equal(poolReports([b, a]).rows[0]!.oneshotSha, 'newer');
});
