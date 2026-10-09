/**
 * Command-line flags that take a ticket iid. Pure, so the boot's refusal can
 * be tested without starting a conductor.
 */

/**
 * A `<flag> <iid>` argument: whether the flag was given at all, and the iid
 * after it when that is a positive integer.
 *
 * `given` with a null `iid` is an operator's slip — `--automation '#8420'`, a
 * bare `--automation` (unquoted, bash reads `#8420` as a comment), or
 * `--automation=8420` — and the caller must refuse it. Read as "no flag", it
 * booted a full watching conductor that scans and claims Loop tickets and
 * spends sessions, when the operator asked for one pass on one ticket.
 */
export function iidFlag(argv: readonly string[], flag: string): { given: boolean; iid: number | null } {
  const given = argv.some((a) => a === flag || a.startsWith(`${flag}=`));
  const i = argv.indexOf(flag);
  if (i === -1) return { given, iid: null };
  const n = Number(argv[i + 1]);
  return { given, iid: Number.isInteger(n) && n > 0 ? n : null };
}

/**
 * `--local-tests <iid>` and its one modifier, `--assume-label`: one pass of
 * the local automation tests mode for one ticket, and whether that pass may
 * treat `Ready for Automation Testing` as present.
 *
 * `error` is the refusal the boot prints, or null. `--assume-label` is refused
 * outside a dry run: on a real desk that label is the request, put on by a
 * person, and a flag standing in for it would post on a ticket nobody asked
 * about. In a dry run nothing reaches GitLab, so it lets a rehearsal be run on
 * any merged ticket. It means nothing without `--local-tests`, and is refused
 * there too rather than ignored. The merged check applies either way.
 */
export function localTestsFlags(
  argv: readonly string[], dryRun: boolean,
): { given: boolean; iid: number | null; assumeLabel: boolean; error: string | null } {
  const { given, iid } = iidFlag(argv, '--local-tests');
  const assumeLabel = argv.some((a) => a === '--assume-label' || a.startsWith('--assume-label='));
  let error: string | null = null;
  if (given && iid === null) {
    error = '--local-tests needs a positive ticket iid, e.g. --local-tests 8800 (no leading #, no =)';
  } else if (assumeLabel && !given) {
    error = '--assume-label only goes with --local-tests <iid>';
  } else if (assumeLabel && !dryRun) {
    error = '--assume-label is only allowed with DRY_RUN=1 — on a real run the "Ready for Automation Testing" '
      + 'label is the request, and only a person puts it on the ticket';
  } else if (argv.some((a) => a.startsWith('--assume-label='))) {
    error = '--assume-label takes no value';
  }
  return { given, iid, assumeLabel, error };
}
