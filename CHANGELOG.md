# Changelog

## [0.1.0] - 2026-07-14

### Added

- `visual-first-ppt` Skill with `create`, strict `template`, and bounded `edit` routes.
- Explicit outline, visual, scope, change-preview, final-approval, QA, and delivery gates.
- Native critical-content contract with generated imagery limited to the visual layer.
- Ten built-in theme contracts, project state/recovery, deterministic QA reports, untouched-slide comparison, and deterministic delivery packaging.
- `verify_handoff_paths.py` with an explicit persistent root, symlink resolution, and out-of-root rejection.
- A `DELIVERED` state guard that binds an existing `finalOutputRoot` plus persistent `finalOutputPath` before packaging.
- Portable RED/GREEN scenario tooling and compact validation summaries.
- Full repository documentation in English, Simplified Chinese, Japanese, and Korean, with a shared language switcher and version-pinned installation instructions.

### Fixed

- Prevented final PPTX, PDF, and ZIP links from using `/tmp` aliases or tool-managed `tmp`, `temp`, `cache`, and `scratch` directories that may be cleaned after the task ends.
- Removed a hard-coded local repository path from reusable scenario prompt generation.
- Removed public-summary references to excluded raw evidence and retained the reusable three-route support scripts.

### Release boundary

- Kept generated route artifacts, raw execution logs, failed-attempt archives, local planning records, virtual environments, and customer decks outside the public Git candidate.
- Added MIT licensing and public installation, usage, validation, evidence, limitation, and privacy documentation.

### Validation baseline

- 59/59 unit tests passed: 38 Node and 21 Python.
- 15/15 RED controls recorded the original behavior gap.
- 15/15 GREEN behavior runs passed all required and forbidden-behavior checks.
- All three synthetic artifact routes reached `DELIVERED` with QA PASS and deterministic package evidence.
- A separate 10-slide education-facing pilot was opened by the user in PowerPoint/WPS without a reported anomaly; the deck is not included in the repository.
