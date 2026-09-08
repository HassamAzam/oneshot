# harness

The Workstream (wsai) Claude Code harness, vendored verbatim so Oneshot owns and
improves it: skills, slash commands, subagents, rules, hook scripts, templates,
settings, plus the repo's `CLAUDE.md` and `AGENTS.md`.

- Source: `git@gitlab.arbisoft.com:arbisoft/workstreamai.git` at `7c6d3df`
  (`.claude/` + `CLAUDE.md` + `AGENTS.md`, tracked files only).
- Layout mirrors a `.claude/` directory and is the default `ONESHOT_SKILLS_ROOT`, so every
  worktree and the conductor root get their `.claude/*` symlinked here (see `src/lib/claudedir.ts`).
  Oneshot's own skills stay in `../skills/` and are merged in at seed time.
- Phases can never write here: `hooks/write-scope.cjs` denies every write under the Oneshot runtime.
