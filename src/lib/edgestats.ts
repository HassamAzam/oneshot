/**
 * Turning repeated judge trials of one ticket's edge coverage into a pass rate
 * and a noise band.
 *
 * The edge judge is an LLM and changes its mind between identical runs, and
 * under --replay the test list itself is regenerated each time, so a single
 * trial's covered/edges is one sample with unknown spread. We take k samples of
 * the same ticket and summarise them: how many trials covered each edge (its
 * pass rate), the edges covered in every trial, the edges that flip from trial
 * to trial (the noise), and the gap between the best and worst trial — the band
 * a real change has to clear before it counts as more than luck.
 *
 * A trial is given as the set of edge ids it covered. k = trials.length.
 */

export interface EdgeTally {
  id: string;
  hits: number;
  trials: number;
}

export interface RepeatStats {
  trials: number;
  perEdge: EdgeTally[];
  coveredEveryTrial: string[];
  flaky: string[];
  missingEveryTrial: string[];
  minCovered: number;
  maxCovered: number;
  meanCovered: number;
  spread: number;
}

export function tallyTrials(edgeIds: readonly string[], trials: ReadonlyArray<ReadonlySet<string>>): RepeatStats {
  const k = trials.length;
  const perEdge: EdgeTally[] = edgeIds.map((id) => ({
    id,
    trials: k,
    hits: trials.reduce((a, t) => a + (t.has(id) ? 1 : 0), 0),
  }));
  const coveredPerTrial = trials.map((t) => edgeIds.reduce((a, id) => a + (t.has(id) ? 1 : 0), 0));
  const minCovered = k ? Math.min(...coveredPerTrial) : 0;
  const maxCovered = k ? Math.max(...coveredPerTrial) : 0;
  return {
    trials: k,
    perEdge,
    coveredEveryTrial: perEdge.filter((e) => k > 0 && e.hits === k).map((e) => e.id),
    flaky: perEdge.filter((e) => e.hits > 0 && e.hits < k).map((e) => e.id),
    missingEveryTrial: perEdge.filter((e) => e.hits === 0).map((e) => e.id),
    minCovered,
    maxCovered,
    meanCovered: k ? coveredPerTrial.reduce((a, c) => a + c, 0) / k : 0,
    spread: maxCovered - minCovered,
  };
}

/** Majority vote across trials: covered when more than half the trials covered it. */
export function majorityCovered(tally: EdgeTally): boolean {
  return tally.hits * 2 > tally.trials;
}

/**
 * A change in a coverage count is real only when it clears the noise band —
 * the run-to-run spread of the same configuration. A smaller move cannot be
 * told apart from the judge (and the agent, under --replay) changing its mind.
 */
export function beyondNoise(delta: number, noise: number): boolean {
  return Math.abs(delta) > noise;
}
