# Rubric — `recall`

What a good `recall.json` looks like, as checks a script can apply without a
grader session. Every check comes from `skills/prior-art-recall/SKILL.md`;
the section it enforces is named beside it. `scripts/eval-phase.ts` applies them.

A sample's score is the share of checks it passes. A ticket's score is the mean
over its N samples, so a check that passes 2 times in 3 shows up as 0.67 rather
than hiding behind one lucky replay.

| Check | Passes when | Skill section |
|---|---|---|
| `no-self` | no entry in `priorTickets` is the ticket being recalled | — |
| `real` | every cited iid exists in the memory: a line in `index.jsonl` or a card in `tickets/` | "An empty brief is a correct answer" (an invented resemblance is worse than nothing) |
| `empty-is-empty` | `priorTickets` empty ⇔ `brief` is `""` | "An empty brief is a correct answer" |
| `cites-iid` | every ticket in `priorTickets` is named as `#<iid>` in the brief | "Name each ticket by iid" |
| `short` | `brief` is at most 1000 characters | "Write a brief that survives being pasted into three prompts" |
| `gold` | every `must` iid is cited, and nothing outside `must ∪ ok` is | the ladder, applied by a person once |
| `files-grounded` | every file path in `brief` or `gotchas` appears in a cited run's index `files` or card | "An empty brief is a correct answer" (an invented resemblance is worse than nothing) |

`empty-is-empty` is the check live runs fail most. #123, #179, #193, #200, #241 and #259
all returned no prior tickets but a non-empty brief. Some said "no prior art" at length,
and #193 and #259 filled it with their own code research. That text is pasted into
research, plan and implement all the same.

`gold` is the only check that needs a person. `evals/recall/gold.json` says,
per ticket, which past runs MUST be found and which MAY be. It is judged against the
frozen memory snapshot, not the live memory, so it stays true until the snapshot is
refreshed. Re-label it whenever you pass `--refresh-memory`.

The score judges the ANSWER only. Out-of-scope work counts against it when it reaches the
output, because that is what research, plan, implement and review are handed: code
research in a brief with no prior tickets fails `empty-is-empty`, and a file path no cited
run touched fails `files-grounded`. Exploring outside the memory without leaking it into
the answer is spend, not a wrong answer, so it shows in `stray` below and not in the score.

Cost is reported next to the score and never folded into it. A prompt change that scores
higher at twice the spend is a trade to decide, not a win.

- `turns`, `weighted`: mean per sample; `weighted` is the quota unit of `config/budgets.json`.
- `secs`: mean wall clock per sample. Samples run 4 at a time, so this runs above a lone live
  run; compare evals with each other before reading much into `vs live`.
- `vs live`: change against the live run's first recall attempt (`run.json`, lap 0), for both
  `weighted` and `secs`.
- `vs prev`: change against the same ticket in the last eval.
- `stray`: mean tool calls outside `state/memory/`, read from the sample's transcript. Live:
  #193 made 44 of its 46 calls in the workstreamai frontend, #53 made 18 of 19.
- `over`: samples past `phases.recall` in `config/budgets.json`, the phase's turn cap or its
  `timeoutMin`.
