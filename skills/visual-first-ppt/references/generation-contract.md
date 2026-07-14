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

Compile each approved outline page into `slide-specs.json`. Every slide record includes:

```json
{
  "slideNumber": 1,
  "role": "content",
  "purpose": "What this page must accomplish",
  "coreConclusion": "One answer-first message",
  "visualLayerSource": "imagegen",
  "nativeObjects": [],
  "safeZone": {"top": "7%", "right": "7%", "bottom": "7%", "left": "7%"},
  "flattened": false,
  "flattenedApprovalHash": null,
  "dataBindings": [],
  "renderEvidence": []
}
```

`visualLayerSource` is one of `source_ppt`, `user_asset`, `imagegen`, `licensed_web`, `native`, or `none`. It states where the visual layer comes from; it does not imply that text or data should be rasterized.

`[NATIVE_CRITICAL_CONTENT]`: 关键文字、精确数据、表格、图表、坐标轴、引用、页码、Logo 和需要复核或编辑的结论默认都必须是原生 PPT 对象. Native objects retain text, geometry, styles, data source IDs, and object IDs in the per-slide inventory. 新建的精确表格和图表必须原生创建；decorative relationships or trend metaphors may be visual imagery only when no precise value is implied.

Use `imagegen` for backgrounds, scenes, people, illustrations, texture, atmosphere, and decoration. Every image request includes the `safeZone`, 16:9 composition, focal point, crop behavior, forbidden regions, and a rule against embedded critical text or exact data. Check faces, hands, products, logos, pseudo-text, and crop integrity before use.

## Imported object inventory and flattening

导入源 PPT 前，必须先盘点图表、表格及其他对象，并写入 per-slide **object inventory**。

Before modifying or reusing a user PPTX, produce an **object inventory** covering every imported 图表、表格、text object, image, group, link, media object, master/layout dependency, animation, and transition in the affected scope. Record whether each object remains native after import/export.

If an imported chart or table becomes an image, choose exactly one status:

1. `rebuild` — reconstruct it as a native object and verify the values;
2. `approved_flatten` — the user accepts the precise editability and fidelity impact;
3. `blocked` — stop because neither safe reconstruction nor accepted flattening is available.

不得把退化成图片的表格或图表报告为可编辑。`[FLATTENED_PAGE_APPROVAL]` requires an explicit approval artifact bound to the exact slide/spec hash. Set `flattened: true` and `flattenedApprovalHash`; also list the affected objects and production-record warning. Silence, urgency, or general deck approval is not flattening authorization. A flattened data table or precise chart is blocked by default.

## Build, render, inspect, repair

`[RENDER_EVERY_BUILD]` applies after every build or edit loop:

1. assemble only from the current approved outline, theme lock, slide specs, and source hashes;
2. save a new output file without overwriting the source;
3. render the full PPTX with the `Presentations` renderer;
4. run the standard PPTX parse, overflow, overlap, placeholder, relationship, and font checks;
5. inspect the rendered montage and any high-risk slide at full resolution;
6. repair affected pages, rebuild, rerender, and repeat until the QA contract passes.

Do not treat a successful file save as visual verification. Populate each slide’s `renderEvidence` with renderer/tool version, image path, build hash, result, and inspection time.

If `imagegen` 生成失败，先按同一视觉合同重试；仍失败时，降级为符合主题的原生布局、用户素材或许可证可核验的网络素材. Record the retry and degradation. Never ship an obviously damaged image, change the visual route silently, or place critical content into a raster fallback.

## First-version exclusions

Add `speaker notes` only when the user 明确要求 speaker notes or provides note content. 第一版不自动生成旁白、不自动嵌入音频，也不新增动画或转场. Existing animations, transitions, media, and notes are compatibility risks: preserve only when the selected workflow can prove fidelity, otherwise block or obtain explicit degradation approval.
