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
