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

Review every rendered slide at full size, not only a montage. Score four dimensions: `readability`, `visualConsistency`, `imageIntegrity`, and `visualContractFidelity`. Each dimension on every page must be at least `4/5`. Also reject any critical fact error, pseudo-text, distorted face/hand/product, broken brand rule, unsafe crop, or misleading generated evidence regardless of numeric score.

Keep reviewer, slide number, score, renderer version, input hash, and evidence image path in the QA report.

## Target-client smoke and PDF disclosure

Open the result in the target client when available and record `passed` or `failed`. If the target client is `not_available`, QA cannot pass until the user records a final-open confirmation in the actual destination client.

Record whether the PDF export is a **raster PDF** or **vector PDF**, which tool created it, and any fidelity/editability consequence. Compare PPTX, PDF, and preview page counts, canvas, fonts, and visible content; do not describe raster output as vector-preserving.

## QA report command

Aggregate JSON evidence files with:

```bash
node skills/visual-first-ppt/scripts/build-qa-report.mjs \
  --project-id ppt-example --route create \
  --input-hashes qa/input-hashes.json \
  --tool-versions qa/tool-versions.json \
  --automated-checks qa/automated-checks.json \
  --manual-scores qa/manual-scores.json \
  --client-smoke qa/client-smoke.json \
  --output qa-report.json
```

The report may say `PASS` only when every required item and evidence path exists and all thresholds pass.

## Deterministic delivery package

Packaging is allowed only from `DELIVERED` state with final approval and a QA `PASS`. Before that transition, copy the approved PPTX to a persistent destination and bind it to the state:

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
