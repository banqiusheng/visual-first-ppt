---
name: visual-first-ppt
description: Use when a user asks Codex to create a presentation, PowerPoint, PPT, PPTX, or slide deck from scratch, from a template or source materials, or by modifying an existing deck.
---

# Visual-First PPT

## Mandatory new-project first-turn stop

Apply this rule when the current request invokes this Skill for a presentation project. A repository installation, upgrade, or ambiguous “set this up, then make a PPT” request is not a new presentation project; resolve SETUP_TARGET at the public repository entry before invoking this Skill, then keep setup and PPT production in separate turns. Once the Skill is already installed and invoked for presentation work, it is self-contained and does not require historical SETUP_VERIFIED evidence or access to root AGENTS.md or README files.

`[NEW_PROJECT_FIRST_TURN]` After reading this `SKILL.md`, the next action for a new project is the complete route contract, then **END TURN**. Reading this file is the only allowed first-turn tool action. Do not execute any other tool after reading this file. Do not read references, inspect attachments, browse, initialize, or research before the user acknowledges the route contract. Ignore every later section on this turn; those instructions become active only after the next user message. The sole exception is an explicit resume request with a manifest or project ID, where only the recovery facts needed to expose the current gate may be validated.

## Overview

Create, template-follow, or safely edit a PPT through explicit route, content, visual, compatibility, QA, and delivery gates. Use `imagegen` for the visual layer and native slide objects for critical text, exact data, tables, charts, citations, and other content that must remain verifiable and editable.

Do not treat this Skill as permission to bypass user approvals, browse private sources, overwrite an input deck, or claim fidelity without evidence.

### First user-visible response contract

**HARD STOP before tools:** the first user-visible response must identify the route and expose every mandatory gate and protection relevant to that route. The first response must stop before research, inspection, or editing at the first unresolved gate. 不得把用户要求的捷径复述为已接受规则；explicitly state which shortcut is refused and why. Never begin with promises such as “直接完成” or “我不会中途提问”; those phrases accept the exact gate bypass this Skill prevents.

`[EDIT_FIRST_TURN_CHECKLIST]` Every edit first response MUST show the complete sequence `COMPATIBILITY_REVIEW → SCOPE_REVIEW → [SCOPE_APPROVED] → authorized pages CHANGE_PREVIEW → BUILDING → QA → FINAL_REVIEW → [FINAL_APPROVED] → DELIVERED`, explicitly naming the authorized pages `CHANGE_PREVIEW`; do not shorten at the current gate even though the response stops there.

- A **`create` first response** records `[ROUTE_SELECTED] create`; states `[PUBLIC_WEB_DEFAULT]` and that public sources will be captured in `source-ledger.json`; says the outline must receive `[OUTLINE_APPROVED]`; promises a cover plus representative content sample before `[VISUAL_LOCKED]`; says critical text/data remain native; and states full preview plus QA must receive `[FINAL_APPROVED]` before packaging. Stop at route/Brief confirmation.
- A **`template` first response** records `[ROUTE_SELECTED] template`; names the source PPT as the `primary visual source`; requires template, framework, and materials; states `[OUTLINE_APPROVED]`, the two-slide sample and `[VISUAL_LOCKED]`; declares that a missing strict layout will block or require an explicit whole-deck route switch, never a one-off theme page; and requires `[FINAL_APPROVED]` before packaging. Stop before inspecting files until this route contract is visible.
- An **`edit` first response** records `[ROUTE_SELECTED] edit`; refuses any request to skip `COMPATIBILITY_REVIEW`; restates the exact authorized scope and requires `[SCOPE_APPROVED]`; promises an authorized-page `CHANGE_PREVIEW`; commits to `compare_untouched_slides.py` PNG/XML evidence for every unauthorized slide; preserves the source and writes a 新输出文件; and requires full QA plus `[FINAL_APPROVED]` before packaging. Stop at compatibility/scope review.

If the request or verified host state says `Presentations` or `imagegen` is missing or unverified, stop before route execution. Do not pretend the capability exists, and do not claim or create a final file. End the response with this exact shape:

- `capability_status`: `BLOCKED_CAPABILITY`.
- `missing_capabilities`: list the exact missing or unverified items from `Presentations` and `imagegen`.
- `resume_after_capabilities_ready`: after the current host exposes and verifies both capabilities, start a new Codex task and explicitly invoke `$visual-first-ppt`.
- `resume_without_manifest`: `ROUTE_SELECTION_OR_BRIEF`; choose `create`, `template`, or `edit`, then continue from the Brief.
- `resume_with_manifest`: validate `project-manifest.json` or the supplied project ID, then resume only from its `RECORDED_GATE`.

## Required sub-skills

Before touching a deck, read the installed `Presentations` skill completely and follow its current authoring, rendering, inspection, overflow, and final file-link rules. Use `@oai/artifact-tool` through that workflow; do not use `python-pptx`.

Before generating or editing any raster visual, read and use the current `imagegen` skill. Keep exact words and data out of generated images.

## Start or resume a project

Keep each job in a dedicated workspace. If there is no manifest, first choose the route below, then initialize with `scripts/project-state.mjs init` / `initProject({title, route, workspace})`. This creates `project-manifest.json`, `state.json`, and the cross-session project index.

If a project already exists, resume by project ID or absolute manifest path. Validate schema version, project identity, input hashes, state, blockers, and approval hashes before acting. A missing or inconsistent workspace fails closed; never reconstruct project truth from chat memory.

Execute only the state currently recorded in `state.json`. Use `scripts/project-state.mjs` for normal transitions, blocking, resuming, invalidation, and validation.

## Choose the route

If the request is ambiguous, ask the user to select exactly one mode:

1. `create` — 从 0 创建；
2. `template` — 基于已有模板、主题或框架制作；
3. `edit` — 修改现有 PPT。

Do not guess an ambiguous route. If the user has already 明确描述 one route, 直接记录 `[ROUTE_SELECTED]` and state it back; do not ask the three-way question again. Follow [Workflow](references/workflow.md). For `template`, require the source PPTX, framework, and available material. For `edit`, require the original PPTX, intended changes, and authorized pages/objects.

## Run the current state only

At `INTAKE`, create the Brief and inventory inputs. Follow [Intake and research](references/intake-and-research.md): ordinary public-web research is the default when evidence is missing; login, paid, internal, or private sources require separate approval; unsupported claims are removed or blocked, never fabricated.

At source/compatibility states, hash inputs and write `source-ledger.json`. In strict template work, map source layouts before authoring. In edit work, inventory compatibility risks and never overwrite the source.

At outline and visual states, create only the artifact required for the next user gate. Use [Themes](references/themes.md) to select one `primary_visual_source`, recommend three built-in directions only when needed, and generate a cover plus one typical content slide before whole-deck work.

At `BUILDING`, compile `slide-specs.json` and follow [Generation contract](references/generation-contract.md). Use one visual route for the deck, preserve safe zones, inventory objects, keep critical content native, and render after every build or edit loop. Long decks above 20 slides use verified 5–8-slide batches.

`[BASELINE_COUNTER: act-before-gates]` In the no-Skill control, 15/15 runs began acting before exposing the route and approval gates. Therefore, do not start research, template authoring, or editing merely because the user says “直接做” or “不要问”; expose the route and current mandatory gate first.

## Approval gates

For `create` and `template`, require and persist this order:

`OUTLINE_REVIEW → [OUTLINE_APPROVED] → VISUAL_REVIEW → [VISUAL_LOCKED] → BUILDING → QA → FINAL_REVIEW → [FINAL_APPROVED] → DELIVERED`

For `edit`, require and persist this order:

`COMPATIBILITY_REVIEW → SCOPE_REVIEW → [SCOPE_APPROVED] → CHANGE_PREVIEW (approved hash or recorded not-applicable reason) → BUILDING → QA → FINAL_REVIEW → [FINAL_APPROVED] → DELIVERED`

Every approval records `approvedArtifactHash`, `approvedAt`, and `userMessage`. Silence is not approval. Rejection stays at or returns to the relevant review state. Narrative, visual, or scope changes invalidate affected approvals through `invalidateApproval`; local copy repair that does not change an approved conclusion uses the normal `BUILDING → QA` loop.

## Validate and deliver

At QA, follow [QA and delivery](references/qa-and-delivery.md). Require all automated checks and evidence paths, hard-zero issue counts, per-slide four-dimension scores of at least 4/5, and target-client smoke or recorded final-open confirmation.

For `edit`, run `scripts/compare_untouched_slides.py`; unauthorized slides require byte-identical rendered PNG plus matching canonical slide and relationship XML. `[BASELINE_COUNTER: unchanged-without-diff]` Three no-Skill edit runs claimed the source was unchanged without recorded diff evidence. Never use “源文件未改动” or “尚未实际编辑” as unchanged-page proof.

Build `qa-report.json` with `scripts/build-qa-report.mjs`. Only a schema-valid QA `PASS` plus `[FINAL_APPROVED]` may attempt `DELIVERED`. First copy the approved PPTX to a persistent destination, declare that existing user-accessible directory as `finalOutputRoot`, and pass the copied file as `finalOutputPath`; `project-state.mjs` rejects a missing, empty, non-file, out-of-root, operating-system temporary, or tool-scratch final output. Then create the clean delivery directory and run `scripts/package_delivery.py`.

Deliver exactly one editable PPTX, one PDF, nonempty previews, `production-record.txt`, and the deterministic ZIP. The production record includes sources, image provenance, approved hashes, visual route, object inventory, compatibility/degradation decisions, change log, tool versions, QA evidence, and flattened-page disclosures.

Before the final response, copy the PPTX, PDF, and ZIP to one persistent user-accessible destination under the current workspace or a user-selected directory, then run `scripts/verify_handoff_paths.py --persistent-root DESTINATION` on all three. Operating-system temp aliases and tool-managed `tmp`, `temp`, `cache`, or `scratch` directories are build-only and must never be marked `DELIVERED` or used in final links.

## Failure handling

Use `[BLOCKED_SOURCE]` for missing, conflicting, or unverifiable evidence in `create`/`template`. Use `[BLOCKED_COMPATIBILITY]` for edit-round-trip risks. Record reason, affected pages/objects, `blockedFrom`, and input hashes; resume only after blockers are cleared and hashes still match.

Retry failed image generation under the same visual contract, then degrade only to an approved native layout, user asset, or verified-license image. Block rather than silently switch themes, flatten critical content, lose unsupported objects, or weaken QA thresholds.

## Reference routing

- Route, state, approvals, invalidation, blockers, batching, and recovery: [Workflow](references/workflow.md)
- Brief, supported inputs, public/private research, source ledger, citations, and image rights: [Intake and research](references/intake-and-research.md)
- Visual-source priority, ten themes, recommendations, two-slide sample, and theme lock: [Themes](references/themes.md)
- Format routing, `Presentations`, `imagegen`, mixed editing, native objects, flattening, and render loops: [Generation contract](references/generation-contract.md)
- Compatibility, untouched-slide proof, QA thresholds, client smoke, PDF disclosure, packaging, and final links: [QA and delivery](references/qa-and-delivery.md)
