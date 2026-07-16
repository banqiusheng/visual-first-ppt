# Support

Use this sequence for installation and discovery problems. It keeps troubleshooting reproducible and prevents private material from entering a public issue.

## 1. Confirm the version

Record the Visual-First PPT release tag or Plugin version you intended to use. This repository's beginner setup pins `v0.2.0`; do not report only “latest.” If you downloaded an archive, keep its filename and compare its checksum with the release checksum before continuing.

## 2. Confirm the Codex surface

State where Codex is running, for example the Codex desktop app or Codex CLI. Also state whether you chose the Plugin path or the Skill-only path. Start a new Codex task after Plugin installation; after a Skill-only installation, first try an explicit `$visual-first-ppt` invocation and start a new task only if the Skill is not discovered.

All `codex ...` commands in this runbook are manual user commands. An active Codex Agent must not start the `codex` executable as a tool action or through a shell or wrapper. Use only controls exposed directly by the current host, or the bounded read-only Skill path checks in this runbook.

## 3. Run doctor

Use the read-only command that matches the setup path. Add `--json` when preparing a support request.

**Repository checkout.** From the repository root, run:

```bash
node skills/visual-first-ppt/scripts/doctor.mjs --json
```

**Skill-only default installation.** Run the copy under the standard Codex Skill root:

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json
```

**Skill-only custom installation.** Substitute the explicitly chosen Skill root; do not guess a personal path:

```bash
SKILL_ROOT="<SKILL_ROOT>"
node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json
```

**Plugin installation.** Plugin storage is controlled by Codex and should not be guessed. Give Codex this safe prompt:

```text
Inspect the installed Visual-First PPT Plugin without modifying files. Find the visual-first-ppt Skill root exposed by that Plugin, run its scripts/doctor.mjs with --skill-root set to that same root and --json, and return only redacted output. Do not install, upgrade, overwrite, or recursively search my home directory.
Use only the Skill root and Plugin information exposed directly by the current host. If the host does not expose that root, stop and report the blocker. Do not guess or scan Plugin-managed storage.
Do not run the codex executable or any codex plugin command from inside this task.
```

If installation stopped before the doctor script became available, submit this truthful structured record instead:

```json
{"status":"NOT_AVAILABLE","reason":"installation stopped before doctor became available"}
```

Do not invent or reconstruct doctor output. The `NOT_AVAILABLE` record is only for a setup that stopped before doctor became available, not a substitute for a diagnostic that can be run.

Exit code `0` means required checks passed. Exit code `2` means required local checks passed but one or more optional Codex capability paths were not exposed. Exit code `1` means a required file, runtime, or explicitly exposed capability is missing.

## 4. Check for an existing installation

Do not overwrite an existing `visual-first-ppt` Skill or Plugin. If setup stops with `EXISTING_INSTALLATION`, first locate the exact target and confirm whether it is Skill-only, Plugin, or only a project-data directory with a similar name.

If no real installation is found, report `EXISTING_INSTALLATION_NOT_FOUND`: a project-data directory is not an installed target. List the checked locations and candidate `v0.2.0`, then ask for the exact path or a fresh install choice and stop. Do not request `UPGRADE_APPROVED`; there is no target to compare or upgrade.

### Skill-only recovery

For the default Skill root, inspect `${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt` first. Inspect a different absolute Skill path only when the user supplied it explicitly. Treat this as setup or upgrade, not PPT production; do not invoke the installed `$visual-first-ppt` workflow. Do not read authentication files, and do not enumerate unrelated environment. Do not run Codex during this setup comparison.

1. Perform a read-only version or content comparison between the exact Skill target and pinned `v0.2.0`. Prefer declared version metadata; otherwise compare `SKILL.md` and the distributable tree by hashes or an equivalent read-only diff.
2. Show the comparison, the target path, and the proposed recovery path. An installation-help request or request to “overwrite” is not replacement authority.
3. Continue only after a separate, path-specific `UPGRADE_APPROVED` response.
4. Move the existing Skill target to a timestamped sibling backup and keep that backup intact.
5. Install the pinned candidate into a fresh destination, then run the matching doctor command and activation check from Sections 2–3.
6. Record `SETUP_VERIFIED` only after the installed entrypoint, doctor result, and explicit `$visual-first-ppt` activation have evidence.
7. If installation or verification fails, stop, perform `ROLLBACK`, and restore the backup. Never merge or recursively delete the old copy.

### Plugin recovery

For Plugin recovery, use only a supported control that the current host directly exposes; do not run `codex plugin ...` from inside the active task. Use only Codex-supported Plugin management, update, and rollback controls. Never guess, move, rename, or recursively delete Plugin-managed storage. Identify a supported recoverable update/rollback path before acting, then follow that control's own recovery flow. If no supported recoverable update/rollback path can be identified, stop and explain the blocker; do not ask for or consume `UPGRADE_APPROVED`.

## 5. Check dependencies

Confirm Node.js 20 or later and Python 3.10 or later are available. The presentation workflow also needs Codex access to the current `Presentations` and `imagegen` capabilities. Development validation additionally uses `PyYAML==6.0.2`; it is not bundled with the distribution.

## 6. Request redacted installation help

Open the repository's **Installation help** issue form and provide:

- Visual-First PPT version;
- Codex surface;
- operating system and version;
- installation method;
- reproduction steps and expected result;
- redacted `doctor --json` output, or the exact truthful `NOT_AVAILABLE` record when setup stopped before doctor became available.

Before posting, replace machine-specific paths with placeholders such as `<HOME>` and remove private or customer information.

Do not include tokens, passwords, account identifiers, personal absolute paths, or customer decks.

For a suspected security vulnerability, do not open a public support issue. Follow [SECURITY.md](SECURITY.md) and use the private reporting path instead.
