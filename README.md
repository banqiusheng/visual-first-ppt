<!-- README_LANGUAGES: en | zh-CN | ja | ko -->

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Visual-First PPT

<!-- BEGIN NEWBIE_QUICK_START -->
## Quick Start

![Four-stage beginner flow](docs/assets/newbie-quick-start.svg)

### 1. Confirm the setup target

Before anything is installed, resolve `SETUP_TARGET`: choose `Plugin` or `Skill-only`, and state whether the installation is new, existing, or unknown. If a request says only “set this up, then make a PPT,” Codex must treat setup and presentation production as two separate steps. It must not guess the install scope or choose a presentation route until setup reaches `SETUP_VERIFIED`.

### 2. Install the pinned release

For the simplest desktop experience, open the Plugin directory and install **Visual-First PPT**. The command line is a transparent fallback and performs two separate actions:

Commands beginning with `codex` in this README are transparent manual fallback commands for the user. An active Codex Agent must not execute the `codex` executable, including `codex plugin ...`, as a tool action or through a shell or wrapper. It must use management controls exposed directly by the current host, or the bounded read-only Skill check at `${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt` below.

```bash
codex plugin marketplace add banqiusheng/visual-first-ppt --ref v0.2.0
codex plugin add visual-first-ppt@visual-first-ppt-marketplace
```

The first command only registers the Marketplace at the pinned `v0.2.0` tag; it does not install the Plugin. The second command installs the Plugin. Start a new Codex task after Plugin installation.

For a Skill-only setup, paste this prompt into Codex:

```text
Use $skill-installer to install visual-first-ppt from this pinned release:
https://github.com/banqiusheng/visual-first-ppt/tree/v0.2.0/skills/visual-first-ppt
Before installing, check for an existing Skill with the same name. If one exists, stop with EXISTING_INSTALLATION and do not overwrite it.
After installation, tell me whether I need to start a new Codex task and how to begin with $visual-first-ppt.
Whether you only explain the installation or perform it, end with the complete verification_plan block, including the installed-copy doctor command, expected and actual results, activation check, and setup status.
```

### 3. Verify before claiming success

An installation command finishing is not proof that the product is ready. `node skills/visual-first-ppt/scripts/doctor.mjs --json` checks a repository checkout, not the installed copy. For a default Skill-only installation, run:

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json
```

For a Plugin installation, use only the Skill root and Plugin information exposed directly by the current host. If the host does not expose that root, stop and report the blocker; never guess or scan Plugin-managed storage. Run the same doctor command against the exposed root. Then start a new Codex task and explicitly invoke `$visual-first-ppt`. Record `SETUP_VERIFIED` only when the installed entrypoint, doctor result, and activation check all have evidence. Doctor exit code `2` confirms the required local files but leaves optional production capabilities unconfirmed; do not describe that as full PPT readiness. See `SUPPORT.md` for the complete diagnostic sequence.

<!-- BEGIN INSTALL_VERIFICATION_RESPONSE -->
Every install-related answer, including guidance-only answers where no installation was run, must end with these fields in this order. “Install and verify” by itself is not a verification method:

- `verification_plan`: `REQUIRED`.
- `installed_target`: the exact installed Skill root or host-exposed Plugin Skill root.
- `doctor_command`: for Skill-only, set `SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"`, then run `node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json`; for Plugin, substitute only the exact Skill root exposed by the host.
- `expected_doctor_result`: `exit 0` with JSON `PASS` confirms all required checks; `exit 2` with JSON `WARN` confirms local requirements but not unexposed production capabilities; `exit 1` with JSON `FAIL` is not usable.
- `doctor_result`: the actual exit code and JSON status; use `NOT_RUN` for guidance-only answers and `NOT_AVAILABLE` when the installed root or check is unavailable.
- `activation_check`: the result from a new Codex turn or task that explicitly invokes `$visual-first-ppt`.
- `setup_status`: report `SETUP_NOT_VERIFIED` until the installed entrypoint, doctor result, and activation check all have evidence; only then report `SETUP_VERIFIED`.
<!-- END INSTALL_VERIFICATION_RESPONSE -->

### 4. Handle an existing installation safely

If setup stops with `EXISTING_INSTALLATION`, do not overwrite it. Paste this prompt into Codex:

```text
An existing visual-first-ppt may be present. Inspect only. Confirm whether the exact target is Skill-only or Plugin; do not confuse it with a similarly named project-data directory. If no real installation is found, report EXISTING_INSTALLATION_NOT_FOUND, list the checked locations and candidate v0.2.0, and ask me for the exact path or a fresh install choice. Do not request upgrade approval.
Skill-only recovery: Treat this as setup or upgrade, not PPT production; do not invoke the installed $visual-first-ppt workflow. Check ${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt first. Inspect a different absolute Skill path only when the user supplied it explicitly. Do not run the codex executable or an unbounded home-directory search. Do not read authentication files, and do not enumerate unrelated environment. Run a read-only version or content comparison against pinned v0.2.0, show the differences and exact Skill target, and stop for a path-specific UPGRADE_APPROVED decision. Only after approval, move the existing Skill target to a timestamped sibling backup, install into a fresh destination, run doctor and the explicit $visual-first-ppt activation check, and perform ROLLBACK by restoring the backup if installation or verification fails. Never merge or recursively delete the old copy.
Plugin recovery: Use only Plugin controls exposed directly by the current host. Do not run codex plugin commands from inside the active task. Use only Codex-supported Plugin management, update, and rollback controls. Never guess, move, rename, or recursively delete Plugin-managed storage. If no supported recoverable update or rollback path can be identified, stop and explain the blocker; do not ask for or consume UPGRADE_APPROVED.
```

### 5. Start the first presentation

If `Presentations` or `imagegen` is missing or unverified, do not pretend it is available and do not claim a final file. Report the exact recovery point first:

<!-- BEGIN CAPABILITY_RECOVERY_RESPONSE -->
- `capability_status`: `BLOCKED_CAPABILITY`.
- `missing_capabilities`: list the exact missing or unverified items from `Presentations` and `imagegen`.
- `resume_after_capabilities_ready`: after the current host exposes and verifies both capabilities, start a new Codex task and explicitly invoke `$visual-first-ppt`.
- `resume_without_manifest`: `ROUTE_SELECTION_OR_BRIEF`; choose `create`, `template`, or `edit`, then continue from the Brief.
- `resume_with_manifest`: validate `project-manifest.json` or the supplied project ID, then resume only from its `RECORDED_GATE`.
<!-- END CAPABILITY_RECOVERY_RESPONSE -->

On the next turn after a verified Skill install, invoke it explicitly. If it is not discovered, start a new Codex task. Then begin with:

```text
Use $visual-first-ppt. First ask me to choose exactly one route: create, template, or edit. Follow the required approval gates before full production.
```

The first reply normally stops at route selection and the approval contract. That is expected design, not a stalled task.
<!-- END NEWBIE_QUICK_START -->

`visual-first-ppt` is a Codex Skill for producing presentation decks through a gated, visual-first workflow. It can create a deck from zero, follow an existing template or framework, or make bounded changes to an existing PPTX.

Generated imagery handles atmosphere, scenes, and visual support. Critical text, exact numbers, tables, charts, citations, and approval evidence remain native and editable. The result is not just a good-looking file: it is a reviewable delivery package with explicit approvals, QA evidence, and persistent handoff paths.

> Community project. This repository is not an official OpenAI product.

## Why this Skill

Presentation work often fails in one of two ways: the deck is editable but visually generic, or it looks polished but has been flattened into images that are hard to verify and revise. This Skill combines both layers:

- image generation for visual direction and explanatory scenes;
- native PowerPoint objects for factual or change-sensitive content;
- explicit approval gates before expensive work continues;
- deterministic checks for edits, packaging, and final handoff;
- public-web research when the user has no source material, with sources and inferences kept distinct.

If the user has no template, the Skill proposes theme directions that fit the audience and topic, then locks one before slide production.

## Supported routes

| Route | Use it when | Required user gates |
| --- | --- | --- |
| `create` | Building a deck from zero | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `template` | Following an existing PPTX, theme, or content framework | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `edit` | Changing an existing PPTX within an authorized scope | `[SCOPE_APPROVED]` → change preview → `[FINAL_APPROVED]` |

The Skill does not interpret “just do it,” silence, or an uploaded file as permission to skip these gates.

## How the workflow runs

1. **Select a route.** Codex confirms `create`, `template`, or `edit` before inspecting or producing content.
2. **Collect inputs.** For `template` and `edit`, the user provides the source PPTX and available material. For `create`, Codex confirms audience, goal, emphasis, length, and constraints.
3. **Research responsibly.** User material comes first. When it is insufficient, Codex can research public sources, record provenance, surface conflicts, and avoid fabricated claims.
4. **Approve structure and visual direction.** The user reviews the outline and, where applicable, locks the visual system before full production. An `edit` project locks the authorized slide scope first.
5. **Build and inspect.** Every slide is rendered. Critical content stays native; generated visuals stay inside declared safe zones. Unauthorized slides in an `edit` project receive PNG and XML comparison evidence.
6. **Validate and deliver.** Automated QA, full-size slide review, target-client smoke or user opening confirmation, final approval, deterministic packaging, and persistent-path verification are separate steps.

## Core safeguards

- Uses the current Codex `Presentations` workflow and `@oai/artifact-tool`; it does not use `python-pptx`.
- Uses `imagegen` for the visual layer, never as the final source of factual text or exact data.
- Preserves the input deck and writes a new output for bounded edits.
- Blocks unsupported or risky compatibility changes unless the user explicitly approves a documented degradation.
- Rejects final files located outside the declared destination root or inside operating-system and tool-managed temp, cache, or scratch paths.
- Packages exactly one editable PPTX, one PDF, previews, a production record, and a deterministic ZIP.

## Requirements

- A Codex environment with the current `Presentations` and `imagegen` skills or capabilities.
- Node.js 20 or later for project state and QA scripts.
- Python 3.10 or later for comparison, packaging, and handoff validation.
- `PyYAML==6.0.2` only for development-time official Skill validation.

This repository does not bundle Codex, PowerPoint, WPS, LibreOffice, `Presentations`, `imagegen`, or `@oai/artifact-tool`.

## Install

For a reproducible install, clone the published release tag and copy only the distributable Skill directory:

```bash
git clone --branch v0.2.0 --depth 1 \
  https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
```

The `test ! -e` guard prevents accidental replacement of an existing Skill. On the next Codex turn, explicitly invoke `$visual-first-ppt`; if it is not discovered, start a new Codex task and invoke it again.

## Example requests

```text
Codex, create an AI teaching-pilot proposal for a vocational-college president from zero.

Use the PPT template and content framework I uploaded to produce a 12-slide solution deck.

Change only slides 4 and 7 in the existing PPT. Keep every other slide unchanged and provide comparison evidence.
```

The first response intentionally stops at route selection and the applicable approval contract.

## Final handoff contract

Build and render work may use scratch directories. Before the final response, copy the approved PPTX, PDF, and ZIP into a persistent directory under the current workspace or a user-selected destination, then run:

```bash
python3 skills/visual-first-ppt/scripts/verify_handoff_paths.py \
  --persistent-root /persistent/output \
  /persistent/output/deck.pptx \
  /persistent/output/deck.pdf \
  /persistent/output/deck-delivery.zip
```

Only verified persistent copies should be linked to the user. The `DELIVERED` transition must also bind the approved PPTX and destination root:

```bash
node skills/visual-first-ppt/scripts/project-state.mjs transition \
  WORKSPACE DELIVERED APPROVED_PPTX_HASH \
  /persistent/output /persistent/output/deck.pptx
```

## Local validation

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

node --test tests/unit/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python \
  -m unittest discover -s tests/unit -p 'test_*.py' -v

SKILL_CREATOR="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator"
.venv/bin/python "$SKILL_CREATOR/scripts/quick_validate.py" \
  skills/visual-first-ppt
```

## Validation evidence

- The checked-in Node and Python test suites are executable release evidence. Release validation requires every test to pass; each run reports its exact current count, avoiding stale hard-coded totals.
- 15/15 RED pressure samples missed at least one required contract item without the Skill.
- 15/15 GREEN behavior runs passed; 75/75 required items passed and 30/30 forbidden behaviors were absent.
- Synthetic `create`, strict `template`, and bounded `edit` routes reached `DELIVERED` with QA PASS. Compact results and hashes are in [`tests/artifacts/artifact-summary.json`](tests/artifacts/artifact-summary.json).
- All three synthetic fixtures passed LibreOffice Impress headless import/export smoke. This is not a claim of Microsoft PowerPoint GUI verification.
- A separate 10-slide education-facing pilot made with this workflow was opened by the user in PowerPoint/WPS on 2026-07-14 without a reported anomaly. That customer deck is not included in this repository.

Compact behavior records are retained in [`tests/baseline/summary.json`](tests/baseline/summary.json) and [`tests/green/summary.json`](tests/green/summary.json). Raw execution logs, customer material, and generated deck artifacts remain outside the public repository; reusable forward-test support scripts remain under `tests/artifacts/support/`.

## Limitations

- Template fidelity depends on source-deck compatibility and must be evidenced, not assumed.
- Animations, SmartArt, OLE objects, linked media, complex masters, missing fonts, and global theme changes may block editing or require explicit degradation approval.
- A raster PDF preserves appearance but not searchable or editable text; the production record must disclose the PDF type.
- Final compatibility still depends on the actual destination client, font availability, and environment.
- Generated scenes are explanatory visuals and must not be presented as evidence of a real school, customer, or completed project.

## Repository layout

- `skills/visual-first-ppt/` — distributable Skill.
- `tests/unit/` — deterministic Node and Python tests.
- `tests/fixtures/` — small neutral PPTX and text fixtures.
- `tests/scenarios/` — RED/GREEN scenario definitions and prompt tooling.
- `tests/artifacts/support/` — reusable three-route forward-test support scripts; generated outputs remain local.
- `tests/*/summary.json` — compact retained evidence; large generated artifacts remain local.

## Release and license

- Current release: [`v0.2.0`](https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.2.0)
- Release history: [`CHANGELOG.md`](CHANGELOG.md)
- License: MIT — see [`LICENSE`](LICENSE)
