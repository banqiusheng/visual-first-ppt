# Compatibility, QA evidence, and delivery

Never equate “file saved” with “deck verified.” A delivery PASS requires 自动检查、全尺寸人工复核、目标客户端烟测, plus route-specific evidence in the versioned `qa-report.json`.

## Compatibility preflight

Before editing or strictly following a source PPTX, inventory:

- 动画 and 转场;
- SmartArt, groups, charts, tables, 链接图表, linked charts, and linked media;
- 嵌入对象、媒体、OLE, external links, and macros;
- complex masters / 复杂母版, custom layouts, placeholders, and theme dependencies;
- speaker notes, hidden slides, comments, sections, and custom shows;
- unsupported fonts and global changes to 全局字体、全局配色、页面比例;
- source renderer, target renderer, and expected output client.

Name every object that may not survive the round trip and state the concrete impact. 不支持或无法证明无损往返的对象默认阻塞；只有用户明确批准该对象及其具名降级影响后才能继续. General approval to “finish the PPT” is not degradation approval.

## Automated checks

Every required check must be present, pass, and include a nonempty evidence path:

`pptxParse`, `pdfParse`, `pageCountAndCanvas`, `overflow`, `unexpectedOverlap`, `unresolvedPlaceholder`, `brokenRelationship`, `fontAvailability`, `nativeObjectTypes`, `dataMismatch`, and `pptxPdfPreviewParity`.

The hard-zero rule is exact: `overflow`, `unexpectedOverlap`, `unresolvedPlaceholder`, `brokenRelationship`, and `dataMismatch` 的计数必须为 0. A missing check is not zero. Any nonzero value blocks PASS.

Current-quality builds use `qualityContractVersion: "1.0.0"` and add structured hard-zero evidence for `textFramePolicy`, `safeMargin`, `fontResolution`, `contentPresence`, and `hiddenVisualResidue`. Each evidence document identifies its checker and version, binds the current deck/slide-spec/theme-lock hashes, lists violations, and reports the final verdict. Self-reported PASS text or an arbitrary nonempty evidence file is invalid.

Run the deterministic OOXML audit before assembling QA:

```bash
python3 skills/visual-first-ppt/scripts/audit_pptx_quality.py \
  --pptx OUTPUT.pptx \
  --slide-specs slide-specs.json \
  --theme-lock theme-lock.json \
  --object-inventory object-inventory.json \
  --output qa/automated-quality.json
```

The audit checks text-frame policy, safe margins, resolved fonts, approved native-content presence, and hidden full-page visual residue. It does not claim to prove pixel visibility, detect every pseudo-glyph, or judge image meaning; those remain full-size human review checks.

For `edit`, also require:

- `sourceHashPreserved` — original PPTX hash and distinct output path;
- `authorizedScope` — approved pages/objects and global-impact record;
- `unauthorizedSlideComparison` — exact PNG hash plus canonical slide/relationship XML evidence for every unauthorized page.

Use:

```bash
python3 skills/visual-first-ppt/scripts/compare_untouched_slides.py \
  --source source.pptx --output revised.pptx \
  --source-render-dir source-render --output-render-dir output-render \
  --authorized-slides 4,7 --report comparison.json
```

Any unauthorized PNG byte change, semantic slide XML change, or relationship-target change blocks delivery. XML whitespace and attribute order are canonicalized; semantic changes are not normalized away.

## Full-size manual review

Review every slide at full-size; a montage is useful for rhythm but is not sufficient for text or detail review. For every page, record reviewer, slide number, current input hash, renderer version, full-size evidence path, evidence SHA-256, pixel width/height, and these three observable PASS checks:

- `contentVisibility`: every approved `contentId` is fully visible in the final render;
- `generatedImageTextReview`: no unapproved text, pseudo-text, fake Chinese, fake data, or watermark appears inside generated imagery;
- `visualSemanticMatch`: the image supports the page's declared `visualIntent` rather than merely matching a generic style.

Also score `readability`, `layoutIntegrity`, `contentCompleteness`, `visualConsistency`, `imageIntegrity`, `visualSemanticMatch`, and `visualContractFidelity`. Every dimension on every page must be at least `4/5`. A score of 3 means the page is not deliverable; 4 is the delivery floor; 5 has no obvious improvement. Record a concrete issue, accepted reason, or repair action for every score below 5. Reject any critical fact error, content omission, unsafe edge, pseudo-text, distorted face/hand/product, broken brand rule, unsafe crop, or misleading generated evidence regardless of numeric score.

Any repair invalidates the current QA evidence for the changed deck. Rebuild, rerender, rerun the deterministic checks, and repeat all affected full-size reviews before requesting final approval.

## Route preservation and legacy exceptions

The quality floors apply to every `create` page, every new `template` page, and every authorized changed `edit` page. Preserved source pages in `template` and unauthorized preserved pages in `edit` use `compatibility-audit` plus source/unchanged evidence; do not alter them merely to satisfy new-page typography or safe-margin floors. A preserved-page risk remains visible in the compatibility record and may still block if round-trip fidelity cannot be proven.

`qaReportCurrent` is the only QA contract that may authorize `QA -> FINAL_REVIEW`, `FINAL_REVIEW -> DELIVERED`, delivered-state validation, or `package_delivery.py`. It requires the current quality-contract identity, all three hash-bound inputs, complete automated/review/manual evidence descriptors, all seven manual dimensions, and a status-consistent client-open record. Legacy artifacts remain readable through `qaReportLegacy` only for migration diagnosis. They cannot create or satisfy a current QA gate hash, authorize a state transition, validate a delivered project, or produce a package. A legacy project must complete migration and regenerate current evidence before rebuild, final review, delivery, or packaging; a missing quality version is never a bypass.

## Target-client smoke and PDF disclosure

Open the exact delivered deck in Microsoft PowerPoint or WPS Presentation and record structured GUI evidence: canonical `targetClient`, `observationMode: "gui-open"`, the delivered deck SHA-256 as `openedArtifactHash`, visible application/deck/canvas observations, and `observedAt`. The QA descriptor also records `evidenceSha256`, computed from the exact structured evidence bytes. The target must exactly equal the hash-bound `theme-lock.json` `targetClient`, and package validation recomputes the evidence hash. Headless LibreOffice import/export is useful automated compatibility evidence, but it cannot claim a PowerPoint or WPS smoke `passed`.

If automated target-client access is `not_available`, the evidence must be an externally supplied `userOpenConfirmationEvidence` with the target client, exact delivered deck hash, the user's own nonempty confirmation message, and confirmation time. Route-evidence helpers accept it only through `--user-open-confirmation-evidence`; they must never generate it or turn a headless diagnostic into confirmation. The resulting QA descriptor remains `NOT_RUN`; the external user-open evidence is the reason delivery may proceed.

PPTX safety limits distinguish parsed package parts from opaque media: XML and relationship parts are capped at 16 MiB each, opaque media at 64 MiB each, total uncompressed output at 128 MiB, compressed source files at 256 MiB, and compression ratio at 200:1. Large media is streamed for comparison; parsed XML is still bounded before parsing. Exceeding any independent limit blocks validation.

Record whether the PDF export is a **raster PDF** or **vector PDF**, which tool created it, and any fidelity/editability consequence. Compare PPTX, PDF, and preview page counts, canvas, fonts, and visible content; do not describe raster output as vector-preserving.

## QA report command

Aggregate JSON evidence files with:

```bash
node skills/visual-first-ppt/scripts/build-qa-report.mjs \
  --project-id ppt-example --route create \
  --input-artifacts qa/input-artifacts.json \
  --tool-versions qa/tool-versions.json \
  --automated-checks qa/automated-checks.json \
  --review-checks qa/review-checks.json \
  --manual-scores qa/manual-scores.json \
  --client-smoke qa/client-smoke.json \
  --output qa-report.json
```

The builder validates its output against `qaReportCurrent`, not the compatibility reader. The report may say `PASS` only when every required item and evidence path exists, every evidence SHA-256 and full-slide dimension is present, all seven score dimensions meet the threshold, and the top-level verdict/client status agrees with every underlying check and client descriptor.

The builder, `project-state.mjs` validation for `FINAL_REVIEW` and `DELIVERED`, and `package_delivery.py` all use the shared current QA semantics in `scripts/lib/current-qa.mjs`. To inspect an existing report without writing any project artifact, run the read-only validator:

```bash
node skills/visual-first-ppt/scripts/validate-current-qa.mjs \
  --qa-report WORKSPACE/qa-report.json \
  --workspace WORKSPACE
```

This shared preflight verifies the exact automated/review/manual identifiers, evidence descriptors and bytes, bound input hashes, continuous slide coverage, unique full-slide PNGs with their dimensions and hashes, all seven score dimensions and notes, target-client evidence, theme/deck binding, and the exact `evidencePaths` projection.

## Deterministic delivery package

Packaging is allowed only from `DELIVERED` state with final approval and a `qaReportCurrent` PASS. The generic `qaReport` compatibility reader and `qaReportLegacy` are never packaging authorities. Packaging loads both `project-manifest.json` and `state.json`; both must use the current quality contract, identify the same project and route, and contain exactly equal `qualityGates`. The package command recomputes `qaReportHash` from the current report and requires it to match both records, so a changed `generatedAt` or any other report byte invalidates the gate. The shared current QA preflight runs before the delivery-only checks for one PPTX/PDF, page counts, preview bytes and dimensions, and the production record. Before the delivery transition, copy the approved PPTX to a persistent destination and bind it to the state:

```bash
node skills/visual-first-ppt/scripts/project-state.mjs transition \
  WORKSPACE DELIVERED APPROVED_PPTX_HASH PERSISTENT_ROOT PERSISTENT_OUTPUT.pptx
```

The state command resolves both `finalOutputRoot` and `finalOutputPath`. The root must be an existing user-accessible directory, and the file must resolve beneath it. Missing, empty, non-file, out-of-root, operating-system temp aliases, and tool-scratch paths all fail closed. After the transition, the delivery directory contains exactly one editable `.pptx`, one `.pdf`, a nonempty `previews/` directory, and `production-record.txt`. Keep state, sources, scratch files, prompts, intermediate JSON, and internal QA working files outside it.

Run:

```bash
python3 skills/visual-first-ppt/scripts/package_delivery.py \
  --workspace WORKSPACE \
  --delivery-dir DELIVERY_DIR \
  --output PERSISTENT_OUTPUT.zip
```

The ZIP uses sorted members and fixed timestamps, and contains a `manifest.json` with SHA-256 and byte size for each delivered file.

The production record lists route, approved artifact hashes, source and image provenance, template or theme lock, per-slide native/flattened inventory, compatibility decisions, render/tool versions, QA evidence, PDF export type, edit change log, and any accepted degradation.

## Persistent handoff gate

Intermediate builds and packaging may use scratch space. Before the final response, copy the approved PPTX, PDF, and ZIP to a persistent user-accessible destination under the current workspace or a user-selected directory. Operating-system and tool-managed temporary directories are build-only and never valid as a final link.

Run the path gate on the copied files:

```bash
python3 skills/visual-first-ppt/scripts/verify_handoff_paths.py \
  --persistent-root PERSISTENT_ROOT \
  PERSISTENT_OUTPUT.pptx PERSISTENT_OUTPUT.pdf PERSISTENT_OUTPUT.zip
```

The command resolves symlinks, requires every file to remain below the declared persistent root, and rejects missing, empty, non-file, out-of-root, operating-system temp aliases, plus `tmp`, `temp`, `cache`, or `scratch` directory components. A failure blocks the handoff even if packaging and QA already passed.

## User-facing handoff

Follow the installed `Presentations` rules for the 最终回复和文件链接: link the PPTX, PDF, preview directory or montage, production record, and ZIP using real absolute local paths. State the output filename, route, editable/flattened exceptions, QA verdict, target-client smoke status, and source preservation result. Never claim “unchanged,” “editable,” or “verified” without the corresponding evidence file.
