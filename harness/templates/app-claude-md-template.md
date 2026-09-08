<!--
  TEMPLATE: apps/<app-name>/CLAUDE.md
  ====================================
  Copy this file to apps/<app-name>/CLAUDE.md and fill in the sections below.

  HOW IT WORKS
  ------------
  Claude Code auto-loads this file into context whenever Claude reads or edits
  a file under apps/<app-name>/. No configuration needed. Nothing to reference
  from the root CLAUDE.md.

  WHAT BELONGS HERE
  -----------------
  - Module-specific knowledge: models, relationships, managers, custom save() behavior
  - Cross-module dependencies: what this app imports and what imports it
  - Data integrity rules NOT enforced by the DB
  - Known data inconsistencies seen in production
  - Edge cases that have caused bugs
  - Debugging heuristics (what to check, in what order)

  WHAT DOES NOT BELONG HERE
  -------------------------
  - Generic Django/DRF patterns — those are in the root CLAUDE.md
  - Cross-cutting stuff that spans many apps — that belongs in root Module Linkages
  - Ephemeral TODOs or in-progress notes

  FINDING CROSS-MODULE DEPENDENCIES
  ---------------------------------
  What this app imports:
      grep "^from apps\." apps/<app-name>/*.py apps/<app-name>/**/*.py

  What imports from this app:
      grep -r "from apps.<app-name>" apps/ --include="*.py" -l

  Delete this comment block when done.
-->

# APP_NAME Module Context

Auto-loaded when Claude reads files in `apps/APP_NAME/`. Contains domain knowledge, cross-module dependencies, and debugging heuristics.

## Core Models (apps/APP_NAME/models.py)

<!-- For each model: one-line description + non-obvious behavior (overridden save, custom managers, signals). -->
<!-- Group by domain if there are many (e.g., "Approvals", "Limits", "Records"). -->

## Cross-Module Dependencies

### APP_NAME imports FROM:
<!-- e.g., apps.core — Person, Status, Config -->

### Other apps import FROM APP_NAME:
<!-- e.g., apps.payroll — uses MODEL_NAME in feature X -->

### Critical Interactions
<!-- For each dependency that causes bugs, 2-3 lines describing the interaction. -->

## Data Integrity Rules

<!-- What must be true about data in this module that isn't enforced by the DB? -->

## Common Data Inconsistencies

<!-- What bad data states have you seen in production? Cause (manual edit vs code)? How to detect? -->

## Known Edge Cases

<!-- Inputs or scenarios that cause surprising behavior. -->

## Debugging Heuristics

<!-- Decision trees: "If X looks wrong, check (1), then (2), then (3)." -->
