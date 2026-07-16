# Visual-First PPT Agent Guide

This repository distributes one Codex Skill for creating, templating, and safely editing editable PowerPoint decks. Read this repository guide before any Skill or Plugin installation. The unique execution entrypoint is `skills/visual-first-ppt/SKILL.md`; do not create or use a second Skill copy.

The installed Skill is self-contained. Root AGENTS.md is not a runtime dependency of `skills/visual-first-ppt/`.

## No nested Codex processes

Commands beginning with `codex` in this repository are transparent manual fallback commands for the user. From an active Codex task, never run the `codex` executable—including `codex exec` or `codex plugin ...`—as a tool action, through a shell, or through a wrapper. Use only management capabilities exposed directly by the current host, or the bounded read-only Skill inspection below. Starting another Codex process creates a different auth, configuration, Skill, rules, and session boundary.

## Request routing

Classify the user's request before acting.

### ambiguous setup + PPT

For an ambiguous request such as “set this up, then make a PPT,” resolve `SETUP_TARGET` first. Ask whether the user wants the Plugin or Skill-only path, and whether the installation state is fresh, existing, or unknown. Do not guess an install target from a repository URL, a vague pronoun, or the later PPT request.

Treat setup and presentation production as separate scopes. Setup must be verified before asking the user to choose `create`, `template`, or `edit`. Do not inspect presentation materials or start production while the setup target or installation state is unresolved.

### inspect

Read the requested repository files and report evidence. Inspection never requires installation and does not authorize a write.

### install

Pin every install to `v0.2.0`. For a Skill request, use `$skill-installer` with `https://github.com/banqiusheng/visual-first-ppt/tree/v0.2.0/skills/visual-first-ppt`. For a Plugin request, use the repository Marketplace source pinned to the same tag.

Check the target before writing. If the same Skill or Plugin already exists, stop with `EXISTING_INSTALLATION`. Do not overwrite, merge, delete, or silently upgrade it.

If bounded inspection finds no real Skill or Plugin target, report `EXISTING_INSTALLATION_NOT_FOUND`. A similarly named project-data directory is not an installed target. State the checked locations, the candidate version `v0.2.0`, and that no content comparison or upgrade can occur yet. Ask the user for the exact path or whether they want a fresh install instead. Do not request UPGRADE_APPROVED until an actual target has been identified and compared.

#### Required installation response

End every install-related answer—including guidance-only answers when no installation was run—with these fields, in this order. Do not replace this concrete plan with “install and verify”:

- `verification_plan`: `REQUIRED`.
- `installed_target`: the exact installed Skill root or host-exposed Plugin Skill root.
- `doctor_command`: for the default Skill-only install, set `SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"`, then run `node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json`; for a Plugin, substitute only the exact Skill root exposed by the host.
- `expected_doctor_result`: `exit 0` with JSON `PASS` confirms every required check; `exit 2` with JSON `WARN` confirms local requirements but not unexposed production capabilities; `exit 1` with JSON `FAIL` is not usable.
- `doctor_result`: the actual exit code and JSON status; use `NOT_RUN` for guidance-only answers and `NOT_AVAILABLE` when the installed root or check is unavailable.
- `activation_check`: the result from a new Codex turn or task that explicitly invokes `$visual-first-ppt`.
- `setup_status`: report `SETUP_NOT_VERIFIED` until the installed entrypoint, doctor result, and activation check all have evidence; only then report `SETUP_VERIFIED`.

#### Skill-only recovery

Treat this as a setup or upgrade request, not a presentation request; do not invoke the installed `$visual-first-ppt` workflow. Check `${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt` first. Inspect a different absolute Skill path only when the user supplied it explicitly. Compare that exact target with the repository candidate pinned to `v0.2.0`; do not run `codex`, an installer, or an unbounded home-directory search during inspection. Do not read auth or authentication files, and do not enumerate unrelated environment variables or settings.

For an existing Skill-only installation, locate the exact Skill target and run a read-only version or content comparison against the pinned candidate. Prefer declared version metadata; when it is unavailable, compare the installed entrypoint and distributable tree by hashes or an equivalent read-only diff. Show the comparison, exact target, and proposed backup path to the user, then stop for a separate, path-specific `UPGRADE_APPROVED` decision; an earlier request to “overwrite” is not sufficient.

Only after approval, move the existing Skill target to a timestamped sibling backup, install the pinned candidate into a fresh destination, and verify the new copy. If installation or verification fails, stop and execute `ROLLBACK` by restoring the backup. Never merge or recursively delete the old copy.

#### Plugin recovery

For an existing Plugin, use only Codex-supported Plugin management, update, and rollback controls. Never guess, move, rename, or recursively delete Plugin-managed storage. First identify a supported recoverable update/rollback path and follow that control's own recovery flow. If no supported recoverable update/rollback path can be identified, stop and explain the blocker; do not ask for or consume `UPGRADE_APPROVED`.

Use only host-provided Plugin management controls exposed directly by the current Codex host. Do not run `codex plugin ...` from inside the active task to discover or update a Plugin. If the host does not expose a supported recoverable control, stop and ask the user to use the Codex interface or provide host-confirmed Plugin information.

If `v0.2.0` or its Release cannot be resolved, stop with `RELEASE_NOT_FOUND`; do not fall back to `main`, another tag, or an unpinned archive.

Record `SETUP_VERIFIED` only when there is evidence for the installed entrypoint, doctor result, and activation check. For the default Skill-only root, run:

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json
```

For a Plugin, locate the Skill root exposed by the installed Plugin and run the same check there. After a Skill installation, on the next Codex turn explicitly invoke `$visual-first-ppt`; if it is not discovered then, start a new Codex task. After a Plugin installation or update, start a new Codex task and explicitly invoke `$visual-first-ppt` before use.

Do not claim that the product is installed or ready before this verification. Doctor exit code `2` can verify the installed files while still leaving production capabilities unconfirmed; report that distinction instead of claiming full PPT readiness.

### use

Invoke `$visual-first-ppt` and follow `skills/visual-first-ppt/SKILL.md`, including its route selection, approval gates, compatibility checks, QA, and delivery rules. Do not bypass the Skill because this repository guide is already available.

If `Presentations` or `imagegen` is missing or unverified, do not pretend the capability exists and do not claim or create a final file. End the answer with these fields, in this order:

- `capability_status`: `BLOCKED_CAPABILITY`.
- `missing_capabilities`: list the exact missing or unverified items from `Presentations` and `imagegen`.
- `resume_after_capabilities_ready`: after the current host exposes and verifies both capabilities, start a new Codex task and explicitly invoke `$visual-first-ppt`.
- `resume_without_manifest`: `ROUTE_SELECTION_OR_BRIEF`; choose `create`, `template`, or `edit`, then continue from the Brief.
- `resume_with_manifest`: validate `project-manifest.json` or the supplied project ID, then resume only from its `RECORDED_GATE`.

### maintain

Keep `skills/visual-first-ppt/` as the only Skill source. Run the repository's Node and Python test suites plus the official Skill and Plugin validators after local changes. Treat metadata drift, unpinned sources, duplicate Skill files, and generated private evidence as failures.

### release

Treat local edits, commit, push, PR, Marketplace submission, tag, and GitHub Release as separate approval gates. This repository guide does not authorize `git push`, a tag, or a GitHub Release. A repository Marketplace file is local distribution scaffolding; its presence does not mean external Marketplace submission is authorized.
