import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { validateSchema } from "../../skills/visual-first-ppt/scripts/lib/schema-validator.mjs";

const expectedThemes = new Map([
  ["minimal-business", "极简商务"],
  ["consulting-report", "咨询汇报"],
  ["future-tech", "科技未来"],
  ["product-launch", "产品发布"],
  ["editorial-story", "杂志叙事"],
  ["education-training", "教育培训"],
  ["academic-defense", "学术答辩"],
  ["government-formal", "政务正式"],
  ["neo-chinese", "新中式"],
  ["creative-energy", "创意活力"],
]);

function assertHex(value, message) {
  assert.match(value, /^#[0-9A-F]{6}$/i, message);
}

test("theme catalog contains ten complete and deterministic theme contracts", async () => {
  const catalogPath = path.resolve("skills/visual-first-ppt/assets/theme-catalog.json");
  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  const schema = JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/project-artifacts.schema.json"),
    "utf8",
  ));
  const schemaResult = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/themeCatalog" },
    catalog,
  );
  assert.equal(schemaResult.valid, true, schemaResult.errors.join("\n"));
  assert.equal(catalog.themes.length, 10);
  assert.equal(new Set(catalog.themes.map((theme) => theme.id)).size, 10);

  for (const theme of catalog.themes) {
    assert.equal(expectedThemes.get(theme.id), theme.labelZh, `unexpected theme ${theme.id}`);
    assert.ok(theme.useWhen.length >= 2, `${theme.id} requires concrete useWhen rules`);
    assert.ok(theme.avoidWhen.length >= 2, `${theme.id} requires concrete avoidWhen rules`);
    for (const mode of ["light", "dark"]) {
      for (const token of ["background", "surface", "primary", "secondary", "accent", "text", "muted"]) {
        assertHex(theme.palettes[mode][token], `${theme.id}.${mode}.${token}`);
      }
    }
    for (const key of ["titleFont", "bodyFont", "numberFont", "titleSize", "bodySize", "captionSize"]) {
      assert.ok(theme.typography[key], `${theme.id} missing typography.${key}`);
    }
    assert.match(theme.imagePromptBase, /16:9/);
    assert.match(theme.negativePrompt, /no embedded critical text or precise data/i);
    assert.doesNotMatch(theme.imagePromptBase, /in the style of|模仿.*艺术家/i);
    for (const style of ["title", "body", "table", "chart"]) {
      assert.ok(theme.nativeTextStyles[style], `${theme.id} missing native ${style} style`);
    }
    for (const role of ["cover", "chapter", "content", "data", "ending"]) {
      assert.ok(theme.pageRoles[role], `${theme.id} missing page role ${role}`);
    }
    for (const safeKey of ["top", "right", "bottom", "left", "imageFocusRule", "cropRule"]) {
      assert.ok(theme.safeZone[safeKey], `${theme.id} missing safeZone.${safeKey}`);
    }
  }
  console.log("10 themes validated");
});

test("theme selection reference locks one visual source behind a two-slide sample gate", async () => {
  const themes = await fs.readFile(
    path.resolve("skills/visual-first-ppt/references/themes.md"),
    "utf8",
  );
  assert.match(themes, /visual-source priority/i);
  assert.match(themes, /primary_visual_source/);
  assert.match(themes, /观众.*场景.*密度.*基调/s);
  assert.match(themes, /三个.*推荐/);
  assert.match(themes, /用户选择.*授权 Codex 代选/s);
  assert.match(themes, /封面.*典型内容页/s);
  assert.match(themes, /theme-lock\.json/);
  assert.match(themes, /Presentations.*默认布局体系/s);
  assert.match(themes, /strict template.*whole-deck route switch/is);
});
