# Workflow and approval contract

Use this file as the state and approval contract for every project. Never infer an approval from silence, urgency, “直接做”, or “不要问”. Persist every route, gate, blocker, and invalidation in the project facts.

## Entry and Brief

Ask this three-way entry question before choosing a route:

> 请问你希望：1）从 0 创建；2）基于已有模板、主题或框架制作；还是 3）修改现有 PPT？

After the user chooses, persist `[ROUTE_SELECTED]` with `route`, `userMessage`, and `selectedAt`. Do not silently guess among `create`, `template`, and `edit` when the answer is ambiguous.

Collect one hybrid Brief, then ask only for omissions, conflicts, or high-risk choices that materially affect the result:

- topic, use scenario, objective, audience, and the decision or action the deck should support;
- priority messages, expected length or speaking time, deadline, and speaker context;
- desired visual tone, brand constraints, available sources, and reference cases;
- edit-only authorized slides/objects and any requested global change;
- explicit assumptions, constraints, and open questions.

Follow the user’s language unless asked otherwise. Default the canvas to `16:9`. If neither slide count nor speaking time is supplied, propose `8–12 页` and record that default as an assumption rather than a user fact.

## Create and template flow

The only normal-flow states are:

`INTAKE → SOURCE_READY → OUTLINE_REVIEW → OUTLINE_APPROVED → VISUAL_REVIEW → VISUAL_LOCKED → BUILDING → QA → FINAL_REVIEW → DELIVERED`

The executable build-entry sequence is:

```text
OUTLINE_APPROVED -> VISUAL_REVIEW -> VISUAL_LOCKED
-> compile slide-specs/theme-lock
-> validate-slide-specs PASS
-> BUILDING -> audit PPTX -> QA
-> QA PASS -> FINAL_REVIEW
```

The state transition rule is `VISUAL_LOCKED -> BUILDING prebuild PASS`: the PASS artifact must be current and bound to the exact slide specs, theme lock, font evidence, and outline/visual approval hashes. The final-review rule is `QA -> FINAL_REVIEW QA PASS`: the QA PASS must be current and bound to the exact built PPTX and its current inputs. A file save or an older PASS never advances either gate.

- In `create`, complete the Brief and source ledger before `SOURCE_READY`.
- In `template`, require the source PPTX, content framework, and available materials. Treat the template as the primary visual source and complete compatibility/mapping notes before the outline.
- At the outline gate, show the narrative and page-level outline. Persist `[OUTLINE_APPROVED]` only after the user approves its exact hash.
- At the visual gate, show a cover plus one representative content slide. Persist `[VISUAL_LOCKED]` only after the user approves the sample and visual contract.
- At the final gate, show the whole-deck preview and QA result. Persist `[FINAL_APPROVED]` before delivery packaging.

## Edit flow

The only normal-flow states are:

`INTAKE → COMPATIBILITY_REVIEW → SCOPE_REVIEW → SCOPE_APPROVED → CHANGE_PREVIEW → BUILDING → QA → FINAL_REVIEW → DELIVERED`

The executable edit build-entry sequence is:

```text
SCOPE_APPROVED -> CHANGE_PREVIEW
-> compile slide-specs/theme-lock
-> validate-slide-specs PASS
-> BUILDING -> audit PPTX -> QA
-> QA PASS -> FINAL_REVIEW
```

The edit transition uses the same current prebuild evidence, additionally bound to the scope and approved change-preview hash or the recorded not-applicable reason. It uses the same `QA -> FINAL_REVIEW QA PASS` rule after the authorized-page build.

- Preserve the input PPTX and write a distinct output file.
- Inventory compatibility risks before asking for scope approval.
- Record authorized slides, objects, global effects, and expected unchanged evidence. Persist `[SCOPE_APPROVED]` only after approval of that exact scope artifact.
- Present changed-slide previews before building. A non-visual copy edit may record a `notApplicableReason`; silence is not approval.
- Final review includes the complete output, change log, QA result, and visual/XML evidence for every unauthorized slide. Persist `[FINAL_APPROVED]` before packaging.

## Approval records and rejection loops

Every approval payload contains all three fields and is bound to a content hash:

```json
{
  "approvedArtifactHash": "sha256:...",
  "approvedAt": "2026-07-13T00:00:00.000Z",
  "userMessage": "用户批准该版本的原始消息"
}
```

An approval is valid only for the recorded artifact hash. A rejection never advances the state: 大纲拒绝必须回到 `OUTLINE_REVIEW`，视觉样张拒绝必须回到 `VISUAL_REVIEW`，范围拒绝必须回到 `SCOPE_REVIEW`，差异预览拒绝留在 `CHANGE_PREVIEW`，QA 失败或成稿拒绝必须回到受影响页面的 `BUILDING` 后再进入 QA。Do not rewrite history by labeling a rejected artifact as approved.

## 审批失效矩阵 / Approval invalidation matrix

| Changed contract | Eligible prior states | Invalidate | Return to |
| --- | --- | --- | --- |
| Narrative structure, chapter order, core conclusion, or data definition | `OUTLINE_APPROVED` through `FINAL_REVIEW` | outline, visual, final | `OUTLINE_REVIEW` |
| Color, typography, image language, layout rhythm, or primary visual source | `VISUAL_LOCKED` through `FINAL_REVIEW` | visual, final | `VISUAL_REVIEW` |
| Edit authorization, affected objects, or global impact | `SCOPE_APPROVED` through `FINAL_REVIEW` | scope, diff preview, final | `SCOPE_REVIEW` |
| Local copy change with no conclusion or visual-contract impact | `BUILDING`, `QA`, `FINAL_REVIEW` | downstream QA/final only | affected pages in `BUILDING` |

Every invalidation records `impact`, `changedArtifactHash`, `reason`, `invalidatedApprovals`, `affectedPages`, `previousState`, and time. Never preserve an upstream approval after its artifact changes.

Any repair that changes slide specs, theme lock, resolved fonts, source hashes, object inventory, approvals, or the built PPTX invalidates the affected prebuild or QA evidence. Recompile and revalidate the changed input; do not relabel an old evidence file as current.

## Blockers

- `[BLOCKED_SOURCE]`: use for missing, conflicting, or unverifiable evidence in `create` and `template`. Record `blockedFrom`, reason, source gaps, and input hashes.
- `[BLOCKED_COMPATIBILITY]`: use for edit-route objects or fidelity risks that cannot be proven safe. Record `blockedFrom`, risk inventory, proposed choices, and input hashes.

Do not route a source blocker through the edit compatibility state or vice versa. Resume only after the blocker list is cleared and the input hashes, schema version, and last approvals still match.

## Long decks and recovery

A deck `超过 20 页` is long-form. Build and QA it in `5–8 页` batches. Persist each batch ID, page range, input hashes, output paths, QA evidence, and completion time before beginning the next batch. If interrupted, continue from the most recent completed batch rather than regenerating accepted pages.

Resume discovery accepts either a `project ID` from `${CODEX_HOME:-$HOME/.codex}/visual-first-ppt/projects.json` or an absolute `manifest path`. Validate the manifest, state, input hashes, schema version, project identity, and approvals before continuing. A missing workspace or mismatch fails closed; do not reconstruct project truth from chat memory.

New and adopted projects record `qualityContractVersion: "1.0.0"`. A legacy project remains readable for diagnosis, but must complete `project-state.mjs adopt-quality` with current prebuild evidence before any rebuild, new QA run, repackaging, or redelivery.
