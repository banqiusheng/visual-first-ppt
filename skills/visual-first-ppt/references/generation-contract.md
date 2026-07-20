# Presentation generation and mixed-editing contract

This Skill orchestrates existing slide and image capabilities; it does not replace their implementation rules. Before any deck work, **read the installed `Presentations` skill completely** and follow its current rendering, inspection, overflow, and edit instructions. Read and use the **current `imagegen` skill** whenever generating or editing raster visuals.

Use `@oai/artifact-tool` through the `Presentations` workflow for local PowerPoint construction and editing. 不得使用 `python-pptx`; it is not the authoring backend for this Skill.

## Deterministic format routing

Route the requested target exactly once:

```text
Existing native Google Slides -> Google Drive Slides workflow
Net-new Google Slides -> verified local PPTX, then native import
PowerPoint/local deck -> Presentations
User template/source deck -> template-following only
Approved custom theme -> explicit custom formatting
Custom theme declined -> Presentations default layout system
```

`[ONE_VISUAL_ROUTE]` means one deck has exactly one primary visual source and one format route. Supporting assets may vary by page, but a template slide, a built-in-theme slide, and a default-layout slide cannot be silently mixed as independent design systems.

For a source deck, `[TEMPLATE_MAPPING_REQUIRED]` applies before authoring: inspect canvas, masters/layouts, fonts, colors, page numbers, recurring roles, placeholders, safe zones, native charts/tables, media, animations, transitions, SmartArt, links, and embedded objects. Map every new page role to a verified source layout. If strict mapping cannot carry the content, block or request a whole-deck route decision; never design one custom exception page.

## Per-slide mixed-editing contract

Compile each approved outline page into `slide-specs.json`. The following example is a complete current artifact that passes the same schema and deterministic prebuild contract as a real project (after binding its project ID, theme lock, state, and approval hashes):

```json
{
  "artifactType": "slideSpecs",
  "schemaVersion": "1.0.0",
  "qualityContractVersion": "1.0.0",
  "projectId": "ppt-generation-contract-example",
  "route": "create",
  "slides": [
    {
      "slide": 1,
      "pageRole": "cover",
      "qualityMode": "enforced",
      "layoutArchetype": "cover-hero-left",
      "contentBlocks": [
        {"contentId": "title", "text": "质量契约测试", "estimatedLines": 1, "maxLines": 2},
        {"contentId": "subtitle", "text": "中央质量契约", "estimatedLines": 1, "maxLines": 2},
        {"contentId": "context", "text": "版式与字体策略共用", "estimatedLines": 1, "maxLines": 2},
        {"contentId": "note", "text": "构建前验证", "estimatedLines": 1, "maxLines": 2}
      ],
      "typographyBudget": {
        "title": {"minimumPt": 28},
        "body": {"minimumPt": 18, "targetPt": 20},
        "caption": {"minimumPt": 14},
        "source": {"minimumPt": 10},
        "pageNumber": {"minimumPt": 10}
      },
      "safeZone": {
        "unit": "in",
        "top": 0.35,
        "right": 0.35,
        "bottom": 0.35,
        "left": 0.35,
        "pageNumberEdge": 0.3
      },
      "visualIntent": {
        "supports": ["主题"],
        "requiredSubjects": ["抽象几何图形"],
        "prohibitedElements": ["可读文本"],
        "textFreeZones": ["左侧"],
        "cropFocus": ["右侧"],
        "semanticEvidence": "视觉元素强调质量与秩序。"
      },
      "nativeCriticalContent": [
        {
          "contentId": "title",
          "text": "质量契约测试",
          "objectId": "slide-1:shape-2",
          "typographyRole": "title"
        }
      ],
      "contentHash": "sha256:7bb0470b991c4f73bae7237f54245e4360fd9b0e9947cc1cc543acd86900d440",
      "overflowPolicy": [
        "split-semantic-unit",
        "compress-without-fact-change",
        "switch-verified-layout"
      ]
    }
  ]
}
```

`visualLayerSource` is one of `source_ppt`, `user_asset`, `imagegen`, `licensed_web`, `native`, or `none`. It states where the visual layer comes from; it does not imply that text or data should be rasterized.

Legacy design notes may use the labels `nativeObjects`, `dataBindings`, and `flattenedApprovalHash`. They are not accepted as undeclared fields inside the current executable `slide-specs.json`: native/flattened identity belongs in the bound object inventory, data-source details belong in the production record, and flattening authorization remains a separate hash-bound approval artifact.

`[NATIVE_CRITICAL_CONTENT]`: 关键文字、精确数据、表格、图表、坐标轴、引用、页码、Logo 和需要复核或编辑的结论默认都必须是原生 PPT 对象. Native objects retain text, geometry, styles, data source IDs, and object IDs in the per-slide inventory. 新建的精确表格和图表必须原生创建；decorative relationships or trend metaphors may be visual imagery only when no precise value is implied.

Every enforced `nativeCriticalContent` item binds its exact displayed OOXML object through `objectId` (`slide-N:shape-M`) and declares `typographyRole`. The binding and role are part of `contentHash`; a matching phrase elsewhere on the slide cannot satisfy the item or borrow a lower typography floor. Text-bearing or critical-bound objects remain ordinary content for safe-margin checks even when their OOXML name says `Decorative` or `Background`.

Use `imagegen` for backgrounds, scenes, people, illustrations, texture, atmosphere, and decoration. Every image request includes the `safeZone`, 16:9 composition, focal point, crop behavior, forbidden regions, and a rule against embedded critical text or exact data. Check faces, hands, products, logos, pseudo-text, and crop integrity before use.

## Prebuild visual-quality contract

For every new or migrated build, write `qualityContractVersion: "1.0.0"` in the project and slide specs. Each enforced 16:9 page carries one core conclusion and no more than 3–4 content blocks. Use these deterministic floors:

- title at least 28pt;
- body target at least 20pt and never below the 18pt hard floor;
- caption at least 14pt;
- source/footnote and page number at least 10pt;
- meaningful content at least 0.35 inch from every edge;
- page number at least 0.30 inch from its nearest edge.

If a page is overloaded, split it at a complete semantic unit first, then shorten only explanatory copy without changing approved facts, then choose another verified archetype in the same visual system. Never shrink below 18pt, grow a text box beyond the canvas, delete approved content, or burn body copy into an image. A split that preserves the semantic unit, order, conclusion, and content hash may use an automatic change preview; a changed semantic unit, order, conclusion, or content hash returns to outline review.

Every image request derives from the page `visualIntent`. It names supported meaning, required subjects, prohibited elements, text-free zones, crop focus, and semantic evidence. A generated image must contain no unapproved text, pseudo-text, fake Chinese, fake data, or watermark. The full-size review later records `visualSemanticMatch` against the same `visualIntent`.

After `[VISUAL_LOCKED]`, or after the approved edit `CHANGE_PREVIEW`, compile `slide-specs.json` and `theme-lock.json`. Call the exported `validateSlideSpecs(...)` function in `scripts/validate-slide-specs.mjs` with the current state path and output path. The resulting PASS binds input hashes and approval hashes to the current artifacts; the `project-state.mjs` build transition recomputes the same evidence before advancing. A repair that changes a bound input must invalidate the affected prebuild or QA evidence and rerun the corresponding check.

Resolved font evidence is part of that binding. Missing fonts, missing glyph coverage, undeclared substitution, or a font change after the visual lock blocks the build until a verified fallback is selected and the sample is approved again. Candidate lists are not proof that a font resolved on the build machine.

## Imported object inventory and flattening

导入源 PPT 前，必须先盘点图表、表格及其他对象，并写入 per-slide **object inventory**。

Before modifying or reusing a user PPTX, produce an **object inventory** covering every displayed top-level OOXML text object, shape, image, connector, group, table, chart, and media frame. Every displayed slide has a nonempty `objects` array. Each object contains exactly `objectId`, `type`, `native`, and `flattened`; `objectId` is globally unique and uses the displayed-slide binding `slide-N:shape-cNvPrId`. The audit resolves presentation relationships, derives the real OOXML type, and rejects missing, extra, duplicate, malformed, or type-mismatched inventory records. Record links, master/layout dependencies, animation, and transition compatibility separately in the production record.

If an imported chart or table becomes an image, choose exactly one status:

1. `rebuild` — reconstruct it as a native object and verify the values;
2. `approved_flatten` — the user accepts the precise editability and fidelity impact;
3. `blocked` — stop because neither safe reconstruction nor accepted flattening is available.

不得把退化成图片的表格或图表报告为可编辑。`[FLATTENED_PAGE_APPROVAL]` requires an explicit approval artifact bound to the exact slide/spec hash. For the OOXML image that now carries the table or chart, keep the semantic `type` (`table` or `chart`), set `native: false` and `flattened: true`, and bind the separate approval artifact in the production record. A normal decorative image uses `type: "image"`, `native: false`, and `flattened: false`. Silence, urgency, or general deck approval is not flattening authorization. A flattened data table or precise chart is blocked by default.

## Build, render, inspect, repair

`[RENDER_EVERY_BUILD]` applies after every build or edit loop:

1. assemble only from the current approved outline, theme lock, slide specs, and source hashes;
2. save a new output file without overwriting the source;
3. render the full PPTX with the `Presentations` renderer;
4. run the standard PPTX parse, overflow, overlap, placeholder, relationship, and font checks plus the structured OOXML quality audit;
5. inspect the rendered montage and any high-risk slide at full resolution;
6. repair affected pages, rebuild, rerender, and repeat until the QA contract passes.

Do not treat a successful file save as visual verification. Populate each slide’s `renderEvidence` with renderer/tool version, image path, build hash, result, and inspection time.

If `imagegen` 生成失败，先按同一视觉合同重试；仍失败时，降级为符合主题的原生布局、用户素材或许可证可核验的网络素材. Record the retry and degradation. Never ship an obviously damaged image, change the visual route silently, or place critical content into a raster fallback.

## First-version exclusions

Add `speaker notes` only when the user 明确要求 speaker notes or provides note content. 第一版不自动生成旁白、不自动嵌入音频，也不新增动画或转场. Existing animations, transitions, media, and notes are compatibility risks: preserve only when the selected workflow can prove fidelity, otherwise block or obtain explicit degradation approval.
