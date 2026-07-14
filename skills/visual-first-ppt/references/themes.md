# Theme selection and visual sample gate

Use one coherent visual contract for the entire deck. A theme is a system of composition, typography, palette, density, imagery, safe zones, and native object styles—not a bag of unrelated slide templates.

## Visual-source priority

Choose and persist exactly one `primary_visual_source`:

1. For `template` and `edit`, the user’s source PPT is primary. Brand rules may validate it only when compatible.
2. For `create`, use user brand guidelines first, then user screenshots/cases/visual references, then an explicit style description, then a built-in theme.
3. Supporting references may constrain the primary source, but they do not become a second visual route.

If the source PPT conflicts with brand guidance or another user reference, present the conflict and record the user’s choice. Never solve the conflict by mixing both systems without approval.

## Recommendation and selection

When a `create` project has no visual direction, evaluate the 观众、使用场景、内容密度与情绪基调, then give exactly 三个主题推荐. For each recommendation, state why it fits, what risk it avoids, and whether the light or dark palette is more appropriate.

The 用户选择其中一个方向，或明确授权 Codex 代选. Record the original user message. The selected built-in theme is explicit custom formatting; do not later fall back to defaults without invalidating the visual approval.

If the user rejects all custom directions, use the `Presentations` 默认布局体系 and record `primary_visual_source: presentations-default`. This is a deliberate fallback, not an unannounced design failure.

## Two-slide visual sample gate

After outline approval, generate only two representative slides: 一页封面和一页典型内容页. The content sample must reflect the expected information density, native text hierarchy, visual layer, and at least one recurring data or content treatment when relevant.

Review the sample for:

- palette and contrast;
- title/body/number hierarchy and Office-safe fonts;
- image language, crop behavior, and visual focus;
- whitespace, rhythm, and page density;
- text safe zones and native table/chart styles;
- consistency with the primary visual source.

Do not build the remaining deck until the exact sample and visual contract hash receive `[VISUAL_LOCKED]`. A rejected sample stays in `VISUAL_REVIEW`; regenerate only the sample pages.

## `theme-lock.json`

Persist a versioned `themeLock` artifact with:

```json
{
  "artifactType": "themeLock",
  "schemaVersion": "1.0.0",
  "projectId": "ppt-...",
  "primary_visual_source": "builtin:education-training",
  "themeId": "education-training",
  "sourcePptHash": null,
  "paletteMode": "light",
  "palette": {},
  "typography": {},
  "imageLanguage": {},
  "composition": {},
  "density": {},
  "safeZone": {},
  "nativeObjectStyles": {},
  "samplePaths": ["visual-samples/cover.png", "visual-samples/content.png"],
  "sampleHashes": [],
  "approval": {
    "approvedArtifactHash": "sha256:...",
    "approvedAt": "2026-07-13T00:00:00.000Z",
    "userMessage": "同意该视觉方向"
  }
}
```

When any locked palette, font, image language, composition rhythm, safe zone, native style, or primary source changes, invalidate visual approval and return to `VISUAL_REVIEW` with a new two-slide sample.

## Strict template limitation

In strict template mode, map every required page role to a verified source layout before authoring. If the template cannot carry required content, enter a compatibility/source blocker and show the closest source layouts. Never introduce a one-off built-in-theme page.

The only allowed escape is an explicit **strict template whole-deck route switch**: the user chooses either to simplify the content to fit the template or to move the entire deck to a newly approved visual system. A whole-deck switch invalidates the prior visual lock and requires a new sample gate.
