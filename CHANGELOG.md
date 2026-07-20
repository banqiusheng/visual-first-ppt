# Changelog

## [Unreleased]

## [0.3.0] - 2026-07-20

- Make the current/legacy QA gate tests self-contained in clean checkouts and bind detached GitHub CI refs to the verified checkout commit.

### Added

- Executable layout, typography, safe-margin, content-visibility, generated-image, and semantic-image quality gates with structured prebuild, OOXML, and full-size review evidence.
- Doctor completeness checks for every visual-quality runtime asset, schema, validator, auditor, and shared helper.
- A read-only current-QA validator shared by report building, project-state validation, and deterministic packaging.

### Changed

- The state workflow now requires current prebuild evidence before `BUILDING` and current QA evidence before `FINAL_REVIEW`; any bound input change invalidates stale evidence.
- QA contracts are split into strict `qaReportCurrent` release evidence and read-only `qaReportLegacy` migration diagnostics; state transitions and packaging accept only the current contract.
- Packaging now requires matching current `project-manifest.json` and `state.json` quality gates and recomputes the exact QA report hash before creating a ZIP.
- Native text remains editable, while overloaded pages split at complete semantic boundaries and unresolved font fallback blocks delivery.
- Existing source pages in `template` and unauthorized preserved pages in `edit` retain compatibility and unchanged-page exceptions instead of being reformatted to new-page defaults.
- Legacy projects remain readable but require explicit quality migration before rebuilding, regenerating QA, repackaging, or redelivery.

### Compatibility

- No new runtime dependency is introduced; the new JavaScript and Python checks use the existing Node.js and Python requirements.
- Existing `v0.2.0` project records remain readable; rebuilding, regenerating QA, repackaging, or redelivery requires explicit migration to the current quality contract.

## [0.2.0] - 2026-07-16

### Added

- Plugin and repository Marketplace scaffolding around the single distributable Skill source.
- Four-language beginner setup guidance for Plugin and Skill-only paths, explicit activation, installed-root diagnostics, and safe handling of ambiguous setup-plus-PPT requests.
- Read-only `doctor.mjs`, a no-overwrite local Skill installer, deterministic distribution builds, public-candidate auditing, repository governance templates, and least-privilege release workflows.
- A frozen 25-run agent-forward release gate with independent read-only reviewers and compact public evidence.

### Changed

- Existing installations now require an exact target, a version or content comparison, path-specific approval, and a recoverable upgrade plan. Similarly named project-data directories are not treated as installations.
- Setup verification now distinguishes copied files, installed-root diagnostics, Codex activation, and full PPT production capability.
- The standalone Skill copy-install path in all four READMEs now runs doctor against the installed copy and points beginners back to Quick Start step 3 before activation.
- Release and installation guidance is pinned to `v0.2.0`; unresolved tags fail closed instead of falling back to `main` or an unpinned archive.

### Fixed

- Copied doctor scripts now execute correctly across the macOS `/var` and `/private/var` path alias.
- Installer verification no longer treats a copied `SKILL.md` alone as proof of a usable installation.
- Public-candidate safeguards now ignore local `.superpowers/` records and fail closed on local execution records, raw `tests/agent-forward/runs/` evidence, and `.jsonl`/`.log` logs even if they enter the Git candidate.

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
