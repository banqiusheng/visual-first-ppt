<!-- README_LANGUAGES: en | zh-CN | ja | ko -->

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Visual-First PPT

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
git clone --branch v0.1.0 --depth 1 \
  https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
```

The `test ! -e` guard prevents accidental replacement of an existing Skill. Start a new Codex task after installation so it can be discovered cleanly.

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

- 59/59 unit tests pass: 38 Node and 21 Python, including localization, persistent-root, and public-evidence-boundary coverage.
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

- Current release: [`v0.1.0`](https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.1.0)
- Release history: [`CHANGELOG.md`](CHANGELOG.md)
- License: MIT — see [`LICENSE`](LICENSE)
