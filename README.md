# Visual-First PPT

`visual-first-ppt` is a Codex Skill for creating, following a template, or safely editing PowerPoint decks. It uses generated imagery for the visual layer while keeping critical text, exact data, tables, charts, citations, and approval evidence native and editable.

The Skill is designed for high-stakes presentation work where a good-looking file is not enough: route selection, outline approval, visual lock, bounded-edit evidence, QA, client opening, and final packaging are separate gates.

## Supported routes

| Route | Use it when | Required user gates |
| --- | --- | --- |
| `create` | Building a deck from zero | `[OUTLINE_APPROVED]`, `[VISUAL_LOCKED]`, `[FINAL_APPROVED]` |
| `template` | Following an existing PPTX, theme, or framework | `[OUTLINE_APPROVED]`, `[VISUAL_LOCKED]`, `[FINAL_APPROVED]` |
| `edit` | Modifying an existing PPTX within an authorized scope | `[SCOPE_APPROVED]`, change preview, `[FINAL_APPROVED]` |

## Core behavior

- Uses the current Codex `Presentations` workflow and `@oai/artifact-tool`; it does not use `python-pptx`.
- Uses `imagegen` for atmosphere, scenes, and visual support—not for final factual text or exact numbers.
- Preserves the input deck and creates a new output for bounded edits.
- Requires PNG/XML evidence for every unauthorized slide in the `edit` route.
- Requires automated QA, full-size per-slide review, and target-client smoke or user final-open confirmation.
- Packages exactly one editable PPTX, one PDF, previews, a production record, and a deterministic ZIP.
- Requires an explicit persistent destination root and rejects out-of-root files, operating-system temp aliases, and tool scratch/cache paths.

## Requirements

- A Codex environment with the current `Presentations` and `imagegen` skills/capabilities.
- Node.js 20 or later for the state and QA scripts.
- Python 3.10 or later for comparison, packaging, and final-handoff validation.
- `PyYAML==6.0.2` only for development-time official Skill validation.

The Skill does not bundle Codex, PowerPoint, WPS, LibreOffice, `Presentations`, `imagegen`, or `@oai/artifact-tool`.

## Install from GitHub

After this repository is published:

```bash
git clone https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
```

The `test ! -e` guard prevents overwriting an existing Skill. Start a new Codex task after installation so the Skill can be discovered cleanly.

## Example requests

```text
Codex，我要从 0 做一份面向职业院校校长的 AI 教学试点方案 PPT。

请基于我上传的 PPT 模板和内容框架制作一份 12 页方案。

只修改现有 PPT 的第 4 页和第 7 页，其余页面必须保持不变并提供差异证据。
```

The first response intentionally stops at the applicable route and approval contract. The Skill does not treat “直接做” or silence as permission to skip gates.

## Final handoff rule

Build and render work may use scratch directories. Before the final response, copy the approved PPTX, PDF, and ZIP to a persistent directory under the current workspace or a user-selected destination, then run:

```bash
python3 skills/visual-first-ppt/scripts/verify_handoff_paths.py \
  --persistent-root /persistent/output \
  /persistent/output/deck.pptx \
  /persistent/output/deck.pdf \
  /persistent/output/deck-delivery.zip
```

Only the verified persistent copies should be linked to the user.

The `DELIVERED` state itself must bind an existing persistent PPTX through the final transition:

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

- RED controls: 15/15 no-Skill pressure samples missed at least one required contract item.
- GREEN behavior: 15/15 passed; 75/75 required items passed and 30/30 forbidden behaviors were absent.
- Unit tests: 58/58 passed (37 Node and 21 Python), including persistent-root and public-evidence-boundary coverage.
- Synthetic create, strict-template, and bounded-edit routes reached `DELIVERED`; compact results and hashes are in [`tests/artifacts/artifact-summary.json`](tests/artifacts/artifact-summary.json).
- The three synthetic fixtures passed LibreOffice Impress headless import/export smoke. They do not claim Microsoft PowerPoint GUI verification.
- Separately, a 10-slide education-facing pilot produced with this workflow was opened by the user in PowerPoint/WPS on 2026-07-14 without a reported anomaly. That customer-facing deck is not included in this repository.

Compact behavior summaries are retained in [`tests/baseline/summary.json`](tests/baseline/summary.json) and [`tests/green/summary.json`](tests/green/summary.json). These are summary-and-hash verification records, not a claim that raw runs or generated decks ship in the repository. Raw execution logs and generated presentation artifacts stay outside the public Git candidate; reusable forward-test support scripts remain under `tests/artifacts/support/`.

## Limitations

- Template fidelity depends on source-deck compatibility and must be evidenced, not assumed.
- Unsupported animations, SmartArt, OLE objects, linked media, complex masters, fonts, or global theme changes may block editing or require explicit degradation approval.
- A raster PDF preserves appearance but not searchable or editable text; the production record must disclose the PDF type.
- Final compatibility still depends on the actual destination client, fonts, and environment.
- Generated scenes are explanatory visuals and must not be presented as evidence of a real school, customer, or completed project.

## Repository layout

- `skills/visual-first-ppt/` — distributable Skill.
- `tests/unit/` — deterministic Node and Python tests.
- `tests/fixtures/` — small neutral PPTX and text fixtures.
- `tests/scenarios/` — RED/GREEN scenario definitions and prompt tooling.
- `tests/artifacts/support/` — reusable three-route forward-test support scripts; generated outputs remain local.
- `tests/*/summary.json` — compact retained evidence; large generated artifacts remain local.

## License

MIT. See [`LICENSE`](LICENSE).
